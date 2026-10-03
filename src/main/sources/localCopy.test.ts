import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import { replaceConsole } from '../catalog/catalogStore'
import { addSourceList, type Fetcher } from './import'
import { backfillLocalCopies, sourcesDir } from './localCopy'
import { listSourceLists, refreshAllSourceLists, refreshSourceList, removeAllSourceLists, removeSourceList } from './manage'

let dir: string
let db: DatabaseSync
let store: string
const list = (title = 'Super Mario World', name = 'Ma liste') => ({ schemaVersion: 1, name, entries: [{ title, console: 'snes', uris: ['https://example.org/a.zip'] }] })
const write = (name: string, data: unknown): string => { const p = join(dir, name); writeFileSync(p, JSON.stringify(data)); return p }
const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rv-src-'))
  store = sourcesDir(dir)
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  const row = (title: string) => ({ title, region: 'Europe', year: null, genre: null, developer: null, crc: null, sha1: null, size: null, variant: false })
  replaceConsole(db, 'snes', [row('Super Mario World (Europe)')], null)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('copie locale des listes ajoutées depuis un fichier', () => {
  it('une liste ajoutée depuis un fichier est copiée dans le dossier de données', async () => {
    const file = write('ma-liste.json', list())
    await addSourceList(db, file, undefined, Date.now(), store)
    const row = db.prepare('SELECT url, local_copy FROM source_lists').get() as { url: string; local_copy: string }
    expect(row.url).toBe(file)
    expect(row.local_copy.startsWith(store)).toBe(true)
    expect(JSON.parse(readFileSync(row.local_copy, 'utf8')).name).toBe('Ma liste')
  })

  it('une URL n a pas de copie locale', async () => {
    await addSourceList(db, 'https://x/list.json', async () => list(), Date.now(), store)
    expect((db.prepare('SELECT local_copy FROM source_lists').get() as { local_copy: string | null }).local_copy).toBeNull()
    expect(existsSync(store)).toBe(false)
  })

  it('deux fichiers de même nom dans des dossiers différents ne s écrasent pas', async () => {
    const a = write('liste.json', list('Super Mario World', 'A'))
    const sub = join(dir, 'autre'); mkdirSync(sub)
    const b = join(sub, 'liste.json'); writeFileSync(b, JSON.stringify(list('Super Mario World', 'B')))
    await addSourceList(db, a, undefined, Date.now(), store)
    await addSourceList(db, b, undefined, Date.now(), store)
    expect(readdirSync(store)).toHaveLength(2)
  })

  it('l actualisation lit la COPIE : le fichier d origine disparu ne change rien, sans erreur', async () => {
    const file = write('ma-liste.json', list())
    await addSourceList(db, file, undefined, Date.now(), store)
    rmSync(file)
    expect(listSourceLists(db)[0].localCopyPath).toMatch(/ma-liste-[0-9a-f]{8}\.json$/)
    const r = await refreshSourceList(db, 1, undefined, Date.now(), store)
    expect(r).toMatchObject({ ok: true, entryCount: 1, matchedCount: 1 })
    expect(count('sources')).toBe(1)
    expect(listSourceLists(db)[0].error).toBeNull()
  })

  it('le fichier d origine n est jamais relu : seule la copie fait foi (pour la modifier, on édite la copie)', async () => {
    const file = write('ma-liste.json', list())
    await addSourceList(db, file, undefined, Date.now(), store)
    writeFileSync(file, JSON.stringify({ ...list(), entries: [...list().entries, { title: 'Autre', console: 'snes', uris: ['https://x/b.zip'] }] }))
    expect(await refreshSourceList(db, 1, undefined, Date.now(), store)).toMatchObject({ ok: true, entryCount: 1 })
    const copy = (db.prepare('SELECT local_copy FROM source_lists').get() as { local_copy: string }).local_copy
    writeFileSync(copy, JSON.stringify({ ...list(), entries: [...list().entries, { title: 'Autre', console: 'snes', uris: ['https://x/b.zip'] }] }))
    expect(await refreshSourceList(db, 1, undefined, Date.now(), store)).toMatchObject({ ok: true, entryCount: 2 })
  })

  it('copie supprimée à la main : erreur claire, les sources déjà importées restent', async () => {
    const file = write('ma-liste.json', list())
    await addSourceList(db, file, undefined, Date.now(), store)
    rmSync(file)
    rmSync(store, { recursive: true, force: true })
    const r = await refreshSourceList(db, 1, undefined, Date.now(), store)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/copie locale introuvable/) })
    expect(count('sources')).toBe(1)
  })

  it('supprimer une liste supprime aussi sa copie', async () => {
    const file = write('ma-liste.json', list())
    await addSourceList(db, file, undefined, Date.now(), store)
    removeSourceList(db, 1)
    expect(readdirSync(store)).toHaveLength(0)
  })

  it('les listes d avant les copies en reçoivent une au démarrage, si le fichier existe encore', async () => {
    const file = write('ancienne.json', list())
    await addSourceList(db, file) // sans dossier : pas de copie, comme avant la fonctionnalité
    await addSourceList(db, 'https://x/u.json', async () => list('Autre', 'U'))
    expect(backfillLocalCopies(db, store)).toBe(1)
    expect(readdirSync(store)).toHaveLength(1)
    rmSync(file)
    expect(await refreshSourceList(db, 1, undefined, Date.now(), store)).toMatchObject({ ok: true })
  })
})

describe('Actualiser tout / Supprimer toutes les sources', () => {
  it('actualise toutes les listes ; une liste en échec n arrête pas les suivantes et est signalée', async () => {
    const a = write('a.json', list('Super Mario World', 'A'))
    const b = write('b.json', list('Super Mario World', 'B'))
    await addSourceList(db, a, undefined, Date.now(), store)
    await addSourceList(db, b, undefined, Date.now(), store)
    rmSync(a); rmSync(store, { recursive: true, force: true }) // A perd son original ET sa copie ; B garde sa copie
    const r = await refreshAllSourceLists(db, undefined, Date.now(), store)
    expect(r.refreshed).toBe(1)
    expect(r.failed).toEqual([{ name: 'A', error: expect.stringMatching(/copie locale introuvable/) }])
  })

  it('un échec inattendu d un fetcher est rapporté sans interrompre', async () => {
    await addSourceList(db, 'https://x/a.json', async () => list('Super Mario World', 'A'))
    await addSourceList(db, 'https://x/b.json', async () => list('Super Mario World', 'B'))
    const fetcher: Fetcher = async (u) => { if (u.endsWith('a.json')) throw new Error('HTTP 503'); return list('Super Mario World', 'B') }
    const r = await refreshAllSourceLists(db, fetcher)
    expect(r.refreshed).toBe(1)
    expect(r.failed).toEqual([{ name: 'A', error: 'HTTP 503' }])
  })

  it('supprime toutes les listes, leurs sources et leurs copies', async () => {
    await addSourceList(db, write('a.json', list('Super Mario World', 'A')), undefined, Date.now(), store)
    await addSourceList(db, 'https://x/b.json', async () => list('Super Mario World', 'B'))
    removeAllSourceLists(db)
    expect(count('source_lists')).toBe(0)
    expect(count('sources')).toBe(0)
    expect(readdirSync(store)).toHaveLength(0)
    expect(count('catalog_games')).toBe(1) // le catalogue n'est pas touché
  })
})
