import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
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
