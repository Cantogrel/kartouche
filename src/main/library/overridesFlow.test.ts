import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppPaths } from '@shared/ipc'
import { migrate } from '../db/migrations'
import { importPaths, type ImportOptions } from './importer'
import { addCatalogGame, listLibrary, relinkUnmatched } from './libraryStore'
import { setOverride } from './overrides'
import { installDownload } from '../downloads/install'
import { getGame, queryCatalog } from '../catalog/catalogStore'

/*
 * Ce que l'utilisateur modifie (titre, description, images) ne doit rien changer à la reconnaissance du jeu, à son téléchargement ni à sa fiche du catalogue.
 * « 123456789 » → crc cbf43926, 9 octets (fixture connue, voir library.test.ts).
 */

let dir: string
let db: DatabaseSync
let paths: AppPaths
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kflow-'))
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db)
  paths = { dataDir: dir, roms: join(dir, 'roms'), emulators: join(dir, 'emulators'), bios: join(dir, 'bios'), saves: join(dir, 'saves'), cache: join(dir, 'cache'), dats: join(dir, 'dats'), logs: join(dir, 'logs') }
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const addGame = (crc: string | null = 'cbf43926'): number =>
  Number(db.prepare("INSERT INTO catalog_games (console, title, name, crc, size, base, dup, genre, year) VALUES ('nes', 'Test (Europe)', 'Test', ?, 9, 'test', 0, 'Action', 1990)").run(crc).lastInsertRowid)
const romFile = (name: string, where = 'src'): string => { const d = join(dir, where); mkdirSync(d, { recursive: true }); const f = join(d, name); writeFileSync(f, '123456789'); return f }
const opt = (): ImportOptions => ({ copy: true, deleteSource: false, romsDir: paths.roms })
const catalogRow = (id: number): unknown => db.prepare('SELECT * FROM catalog_games WHERE id = ?').get(id)

describe('un jeu modifié par l’utilisateur', () => {
  it('reste reconnu : réimporter la même ROM retombe sur la même entrée, sans toucher à ce que l’utilisateur a modifié', async () => {
    const gameId = addGame()
    await importPaths(db, [romFile('Test.nes')], opt())
    const [first] = listLibrary(db)
    expect(first).toMatchObject({ gameId, match: 'hash', title: 'Test' })
    setOverride(db, first.id, 'title', 'Mon Test à moi')
    setOverride(db, first.id, 'genre', 'RPG')

    const again = await importPaths(db, [romFile('Autre nom.nes', 'copie')], opt())
    expect(again.items[0].status).toBe('duplicate')
    const list = listLibrary(db)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: first.id, gameId, match: 'hash', title: 'Test', shownTitle: 'Mon Test à moi', overridden: ['title', 'genre'] })
  })

  it('reste téléchargeable : l’installation depuis une source retrouve l’entrée par le jeu du catalogue, pas par son titre', async () => {
    const gameId = addGame()
    const entry = addCatalogGame(db, gameId)!
    db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('L', 'https://x/l.json', 0)").run()
    db.prepare("INSERT INTO sources (list_id, game_id, console, title, uris, matched) VALUES (1, ?, 'nes', 'Test', '[]', 1)").run(gameId)
    setOverride(db, entry.id, 'title', 'Totalement autre chose')
    expect(listLibrary(db)[0]).toMatchObject({ hasSources: true, shownTitle: 'Totalement autre chose' })

    const dl = join(dir, 'dl'); mkdirSync(dl); writeFileSync(join(dl, 'Test.nes'), '123456789')
    expect(await installDownload(db, 1, join(dl, 'Test.nes'), paths)).toEqual({ ok: true })
    const list = listLibrary(db)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: entry.id, gameId, match: 'hash', missing: false, title: 'Test', shownTitle: 'Totalement autre chose' })
  })

  it('reste identifiable plus tard : relinkUnmatched rattache l’entrée au catalogue, le titre de l’utilisateur n’est pas écrasé', () => {
    const id = Number(db.prepare("INSERT INTO library (console, title, path, size, match, added_at, crc) VALUES ('nes', 'Inconnu', 'p', 9, 'none', 0, 'CBF43926')").run().lastInsertRowid)
    setOverride(db, id, 'title', 'Mon titre')
    const gameId = addGame('CBF43926')
    expect(relinkUnmatched(db)).toBe(1)
    expect(listLibrary(db)[0]).toMatchObject({ id, gameId, title: 'Test', shownTitle: 'Mon titre' })
  })

  it('n’altère jamais la fiche du catalogue ni ses recherches', () => {
    const gameId = addGame()
    const entry = addCatalogGame(db, gameId)!
    const before = { row: catalogRow(gameId), game: getGame(db, gameId), page: queryCatalog(db, {}) }
    for (const [field, value] of [['title', 'Autre'], ['description', 'Texte à moi'], ['genre', 'RPG'], ['year', '1999'], ['developer', 'Moi'], ['cover', `${entry.id}/cover-1.png`]] as const) setOverride(db, entry.id, field, value)
    expect(catalogRow(gameId)).toEqual(before.row)
    expect(getGame(db, gameId)).toEqual(before.game)
    expect(queryCatalog(db, {})).toEqual(before.page)
    expect(queryCatalog(db, { q: 'Autre' }).games).toHaveLength(0) // le titre modifié n'est pas cherché dans le catalogue
  })
})
