import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS, migrate } from '../db/migrations'
import { addCatalogGame, clearLibrary, listLibrary, removeEntry, saveDir } from './libraryStore'
import { clearAllOverrides, clearOverride, getEntryView, getOverrides, loadOverrides, setOverride } from './overrides'

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
afterEach(() => db.close())

const addEntry = (title: string, console = 'snes', extra: { gameId?: number | null } = {}): number =>
  Number(db.prepare("INSERT INTO library (game_id, console, title, path, size, match, added_at) VALUES (?, ?, ?, ?, 1, 'hash', 0)")
    .run(extra.gameId ?? null, console, title, `p:${title}`).lastInsertRowid)

describe('migration library_overrides', () => {
  it('s’ajoute à une base déjà en v18 sans toucher à la bibliothèque, et reste idempotente', () => {
    const old = new DatabaseSync(':memory:')
    migrate(old, MIGRATIONS.slice(0, 18))
    old.prepare("INSERT INTO library (console, title, path, size, match, added_at) VALUES ('snes', 'Zelda', 'p', 1, 'hash', 0)").run()
    expect(migrate(old)).toBe(MIGRATIONS.length)
    expect(migrate(old)).toBe(MIGRATIONS.length)
    expect(old.prepare('SELECT title FROM library').all()).toEqual([{ title: 'Zelda' }])
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'library_overrides'").all()).toHaveLength(1)
    old.close()
  })
})

describe('setOverride / clearOverride', () => {
  it('enregistre, remplace et lit les surcharges d’une entrée', () => {
    const id = addEntry('Super Mario World')
    expect(setOverride(db, id, 'title', '  Mon Mario  ')).toBe('Mon Mario')
    expect(setOverride(db, id, 'title', 'Mario 2')).toBe('Mario 2')
    expect(setOverride(db, id, 'year', '1991')).toBe('1991')
    expect(getOverrides(db, id)).toEqual({ title: 'Mario 2', year: '1991' })
  })

  it('une valeur vide ou invalide rétablit l’origine', () => {
    const id = addEntry('Zelda')
    setOverride(db, id, 'title', 'Link')
    expect(setOverride(db, id, 'title', '   ')).toBeNull()
    expect(getOverrides(db, id)).toEqual({})
    setOverride(db, id, 'year', '1991')
    expect(setOverride(db, id, 'year', '19')).toBeNull()
    expect(getOverrides(db, id)).toEqual({})
  })

  it('refuse un champ inconnu ou une entrée absente, sans rien écrire', () => {
    const id = addEntry('Zelda')
    expect(setOverride(db, id, 'nope' as never, 'x')).toBeUndefined()
    expect(setOverride(db, 9999, 'title', 'x')).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_overrides').get()).toEqual({ n: 0 })
  })

  it('clearOverride et clearAllOverrides ne touchent que l’entrée visée', () => {
    const a = addEntry('A'); const b = addEntry('B')
    for (const id of [a, b]) { setOverride(db, id, 'title', `T${id}`); setOverride(db, id, 'genre', 'G') }
    clearOverride(db, a, 'title')
    expect(getOverrides(db, a)).toEqual({ genre: 'G' })
    clearAllOverrides(db, a)
    expect(getOverrides(db, a)).toEqual({})
    expect(getOverrides(db, b)).toEqual({ title: `T${b}`, genre: 'G' })
  })

  it('ignore (sans la supprimer) une ligne dont le champ vient d’une version plus récente', () => {
    const id = addEntry('A')
    db.prepare("INSERT INTO library_overrides (entry_id, field, value, updated_at) VALUES (?, 'futur', 'x', 0)").run(id)
    expect(loadOverrides(db).get(id)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_overrides').get()).toEqual({ n: 1 })
  })
})

describe('liste de la bibliothèque et vue affichée', () => {
  it('shownTitle suit la surcharge, le titre d’origine ne bouge pas, le tri suit le titre affiché', () => {
    const a = addEntry('Alpha'); const b = addEntry('Bravo'); addEntry('Charlie')
    expect(listLibrary(db).map((e) => e.shownTitle)).toEqual(['Alpha', 'Bravo', 'Charlie'])
    setOverride(db, a, 'title', 'Zulu')
    setOverride(db, b, 'genre', 'RPG')
    const list = listLibrary(db)
    expect(list.map((e) => e.shownTitle)).toEqual(['Bravo', 'Charlie', 'Zulu'])
    const alpha = list.find((e) => e.id === a)!
    expect(alpha.title).toBe('Alpha')
    expect(alpha.overridden).toEqual(['title'])
    expect(list.find((e) => e.id === b)!.overridden).toEqual(['genre'])
  })

  it('addCatalogGame renvoie l’entrée existante avec ses surcharges', () => {
    const gid = Number(db.prepare("INSERT INTO catalog_games (console, title, name, base, dup) VALUES ('snes', 'Zelda', 'Zelda', 'zelda', 0)").run().lastInsertRowid)
    const first = addCatalogGame(db, gid)!
    setOverride(db, first.id, 'title', 'Link')
    expect(addCatalogGame(db, gid)).toMatchObject({ id: first.id, title: 'Zelda', shownTitle: 'Link' })
  })

  it('getEntryView complète avec le catalogue (genre, année, éditeur) et applique les surcharges', () => {
    const gid = Number(db.prepare("INSERT INTO catalog_games (console, title, name, base, dup, genre, year, developer) VALUES ('snes', 'Zelda', 'Zelda', 'zelda', 0, 'Aventure', 1992, 'Nintendo')").run().lastInsertRowid)
    const id = addEntry('Zelda', 'snes', { gameId: gid })
    setOverride(db, id, 'developer', 'Moi')
    setOverride(db, id, 'background', '1/bg.jpg')
    expect(getEntryView(db, id, { description: 'Texte' })).toMatchObject({
      title: 'Zelda', description: 'Texte', genre: 'Aventure', year: 1992, developer: 'Moi', images: { background: '1/bg.jpg' }, overridden: ['developer', 'background']
    })
    expect(getEntryView(db, 9999)).toBeNull()
  })
})

describe('invariants d’identité', () => {
  it('modifier un jeu ne change ni son titre d’origine, ni sa console, ni son game_id, ni son dossier de sauvegardes', () => {
    const gid = Number(db.prepare("INSERT INTO catalog_games (console, title, name, base, dup) VALUES ('snes', 'Zelda', 'Zelda', 'zelda', 0)").run().lastInsertRowid)
    const id = addEntry('Zelda', 'snes', { gameId: gid })
    const before = db.prepare('SELECT console, title, game_id, path, match FROM library WHERE id = ?').get(id)
    setOverride(db, id, 'title', 'Totalement autre chose')
    expect(db.prepare('SELECT console, title, game_id, path, match FROM library WHERE id = ?').get(id)).toEqual(before)
    expect(db.prepare('SELECT title FROM catalog_games WHERE id = ?').get(gid)).toEqual({ title: 'Zelda' })
    const e = listLibrary(db)[0]
    expect(saveDir('/saves', e)).toBe(saveDir('/saves', { console: 'snes', title: 'Zelda' }))
  })

  it('les surcharges partent avec l’entrée (suppression, vidage de la bibliothèque)', async () => {
    const a = addEntry('A'); const b = addEntry('B')
    setOverride(db, a, 'title', 'x'); setOverride(db, b, 'title', 'y')
    await removeEntry(db, a, 'entry', '/saves')
    expect(db.prepare('SELECT entry_id FROM library_overrides').all()).toEqual([{ entry_id: b }])
    clearLibrary(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_overrides').get()).toEqual({ n: 0 })
  })

  it('aucun module d’identification, de téléchargement, de sources ni de catalogue ne lit la surcouche ni le titre affiché', () => {
    const root = join(process.cwd(), 'src', 'main')
    const files: string[] = []
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p) } }
    for (const g of ['catalog', 'downloads', 'sources']) walk(join(root, g))
    for (const f of ['identify.ts', 'importer.ts', 'hash.ts', 'archive.ts', 'nsz.ts', 'switchContent.ts']) files.push(join(root, 'library', f))
    walk(join(root, 'library', 'content'))
    const offenders = files
      .filter((f) => f.endsWith('.ts') && !/\.(test|testutil)\.ts$/.test(f))
      .filter((f) => /shownTitle|library\/overrides|from '\.\/overrides'|from '\.\.\/library\/overrides'|@shared\/overrides/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
