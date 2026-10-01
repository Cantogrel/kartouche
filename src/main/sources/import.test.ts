import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import { replaceConsole } from '../catalog/catalogStore'
import { addSourceList, type Fetcher } from './import'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  const row = (title: string) => ({ title, region: 'Europe', year: null, genre: null, developer: null, crc: null, sha1: null, size: null, variant: false })
  replaceConsole(db, 'snes', [row('Super Mario World (Europe)')], null)
})

const LIST = {
  schemaVersion: 1,
  name: 'Ma liste',
  entries: [
    { title: 'Super Mario World', console: 'snes', uris: ['https://example.org/smw.zip'] },
    { title: 'Jeu Inconnu Du Catalogue', console: 'snes', uris: ['https://example.org/inconnu.zip'] }
  ]
}
const fakeFetch = (data: unknown = LIST): Fetcher => async () => data

describe('addSourceList', () => {
  it('peuple source_lists et sources, rapproche par titre+console', async () => {
    const result = await addSourceList(db, 'https://example.org/list.json', fakeFetch())
    expect(result).toMatchObject({ name: 'Ma liste', entryCount: 2, matchedCount: 1 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM source_lists').get() as { n: number }).n).toBe(1)
    const rows = db.prepare('SELECT title, matched, game_id FROM sources ORDER BY title').all() as { title: string; matched: number; game_id: number | null }[]
    expect(rows[1]).toMatchObject({ title: 'Super Mario World', matched: 1 })
    expect(rows[1].game_id).not.toBeNull()
  })

  it('conserve une entrée non rapprochée avec matched=0, sans la perdre', async () => {
    await addSourceList(db, 'https://example.org/list.json', fakeFetch())
    const row = db.prepare("SELECT matched, game_id FROM sources WHERE title = 'Jeu Inconnu Du Catalogue'").get() as { matched: number; game_id: number | null }
    expect(row).toEqual({ matched: 0, game_id: null })
  })

  it('refuse une URL déjà ajoutée avec un message clair', async () => {
    await addSourceList(db, 'https://example.org/list.json', fakeFetch())
    await expect(addSourceList(db, 'https://example.org/list.json', fakeFetch())).rejects.toThrow(/déjà été ajoutée/)
  })

  it('refuse une liste invalide sans rien insérer', async () => {
    await expect(addSourceList(db, 'https://example.org/bad.json', fakeFetch({ schemaVersion: 1, name: '', entries: [] }))).rejects.toThrow(/liste invalide/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM source_lists').get() as { n: number }).n).toBe(0)
  })
})

describe('addSourceList — régions dupliquées (markDuplicates)', () => {
  it('rapproche toujours sur la variante représentative (dup=0) affichée par défaut, jamais une région masquée', async () => {
    // Asie insérée en premier (id le plus bas) : avant le filtre dup=0, le matcher collait sur la première ligne
    // trouvée pour un titre normalisé, souvent cette variante cachée plutôt que la représentative (Europe) affichée.
    const row = (title: string, region: string) =>
      ({ title, region, year: null, genre: null, developer: null, crc: null, sha1: null, size: null, variant: false })
    replaceConsole(db, 'psp', [
      row('God of War - Chains of Olympus (Asia) (En,Zh)', 'Asia'),
      row('God of War - Chains of Olympus (Europe) (En,Fr,De,Es,It)', 'Europe'),
      row('God of War - Chains of Olympus (USA)', 'USA')
    ], null)
    const europeId = (db.prepare("SELECT id, dup FROM catalog_games WHERE title = 'God of War - Chains of Olympus (Europe) (En,Fr,De,Es,It)'").get() as { id: number; dup: number }).id

    const list = {
      schemaVersion: 1, name: 'PSN',
      entries: [
        { title: 'God of War - Chains of Olympus (Asia) (En,Zh) (PSN)', console: 'psp', uris: ['https://x/a.zip'] },
        { title: 'God of War - Chains of Olympus (Europe) (En,Fr,De,Es,It) (PSN)', console: 'psp', uris: ['https://x/e.zip'] },
        { title: 'God of War - Chains of Olympus (USA) (PSN)', console: 'psp', uris: ['https://x/u.zip'] }
      ]
    }
    const result = await addSourceList(db, 'https://x/psn.json', fakeFetch(list))
    expect(result.matchedCount).toBe(3)
    const gameIds = (db.prepare('SELECT DISTINCT game_id FROM sources WHERE list_id = ?').all(result.listId) as { game_id: number }[]).map((r) => r.game_id)
    expect(gameIds).toEqual([europeId]) // les 3 régions se rapprochent toutes de LA MÊME entrée, la représentative
  })
})

describe('addSourceList (fichier local, defaultFetch réel)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-sources-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('accepte un chemin de fichier local (glisser-déposer / sélecteur), pas seulement une URL http(s)', async () => {
    const file = join(dir, 'liste.json')
    writeFileSync(file, JSON.stringify(LIST))
    const result = await addSourceList(db, file)
    expect(result).toMatchObject({ name: 'Ma liste', entryCount: 2, matchedCount: 1 })
    expect((db.prepare('SELECT url FROM source_lists').get() as { url: string }).url).toBe(file)
  })
})
