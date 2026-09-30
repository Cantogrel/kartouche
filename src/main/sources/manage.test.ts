import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { replaceConsole } from '../catalog/catalogStore'
import { addSourceList, type Fetcher } from './import'
import { listSourceLists, refreshSourceList, removeSourceList } from './manage'

let db: DatabaseSync
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  const row = (title: string) => ({ title, region: 'Europe', year: null, genre: null, developer: null, crc: null, sha1: null, size: null, variant: false })
  replaceConsole(db, 'snes', [row('Super Mario World (Europe)')], null)
})

const LIST = { schemaVersion: 1, name: 'Ma liste', entries: [{ title: 'Super Mario World', console: 'snes', uris: ['https://x/smw.zip'] }] }
const fetchOk = (data: unknown = LIST): Fetcher => async () => data
const fetchFail = (message = 'réseau indisponible'): Fetcher => async () => { throw new Error(message) }

describe('refreshSourceList', () => {
  it('un rafraîchissement réussi met à jour last_refreshed_at, entry_count et efface une erreur précédente', async () => {
    const { listId } = await addSourceList(db, 'https://x/list.json', fetchOk())
    db.prepare('UPDATE source_lists SET error = ?, last_refreshed_at = 1 WHERE id = ?').run('ancienne erreur', listId)

    const result = await refreshSourceList(db, listId, fetchOk({ ...LIST, entries: [...LIST.entries, { title: 'Autre Jeu', console: 'snes', uris: ['https://x/autre.zip'] }] }), 5000)
    expect(result).toMatchObject({ ok: true, entryCount: 2, matchedCount: 1 })
    const row = db.prepare('SELECT last_refreshed_at, entry_count, error FROM source_lists WHERE id = ?').get(listId) as { last_refreshed_at: number; entry_count: number; error: string | null }
    expect(row).toEqual({ last_refreshed_at: 5000, entry_count: 2, error: null })
  })

  it('un échec réseau conserve les sources précédentes et renseigne error', async () => {
    const { listId } = await addSourceList(db, 'https://x/list.json', fetchOk())
    const before = db.prepare('SELECT * FROM sources WHERE list_id = ?').all(listId)

    const result = await refreshSourceList(db, listId, fetchFail('HTTP 503'))
    expect(result).toEqual({ ok: false, error: 'HTTP 503' })
    expect(db.prepare('SELECT * FROM sources WHERE list_id = ?').all(listId)).toEqual(before)
    expect((db.prepare('SELECT error FROM source_lists WHERE id = ?').get(listId) as { error: string }).error).toBe('HTTP 503')
  })

  it('une liste invalide au rafraîchissement conserve aussi les sources précédentes', async () => {
    const { listId } = await addSourceList(db, 'https://x/list.json', fetchOk())
    const result = await refreshSourceList(db, listId, fetchOk({ schemaVersion: 1, name: '', entries: [] }))
    expect(result.ok).toBe(false)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sources WHERE list_id = ?').get(listId) as { n: number }).n).toBe(1)
  })
})

describe('listSourceLists', () => {
  it('résume chaque liste avec son nombre de jeux reconnus', async () => {
    const withUnknown = { ...LIST, entries: [...LIST.entries, { title: 'Jeu Inconnu', console: 'snes', uris: ['https://x/u.zip'] }] }
    const { listId } = await addSourceList(db, 'https://x/list.json', fetchOk(withUnknown))
    const [summary] = listSourceLists(db)
    expect(summary).toMatchObject({ id: listId, name: 'Ma liste', url: 'https://x/list.json', entryCount: 2, matchedCount: 1, error: null })
  })
})

describe('removeSourceList', () => {
  it('retire une liste et ses sources sans toucher aux autres listes', async () => {
    const a = await addSourceList(db, 'https://x/a.json', fetchOk({ ...LIST, name: 'A' }))
    const b = await addSourceList(db, 'https://x/b.json', fetchOk({ ...LIST, name: 'B' }))

    removeSourceList(db, a.listId)

    expect(db.prepare('SELECT id FROM source_lists').all()).toEqual([{ id: b.listId }])
    expect((db.prepare('SELECT COUNT(*) AS n FROM sources WHERE list_id = ?').get(a.listId) as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sources WHERE list_id = ?').get(b.listId) as { n: number }).n).toBe(1)
  })
})
