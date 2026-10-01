import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SOURCE_FILTER_ANY } from '@shared/catalog'
import { migrate } from '../db/migrations'
import { replaceConsole } from '../catalog/catalogStore'
import { addSourceList, type Fetcher } from './import'
import { listSourceLists, refreshSourceList, removeSourceList, sourcesForGame } from './manage'
import { queryCatalog } from '../catalog/catalogStore'

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

describe('sourcesForGame', () => {
  it("renvoie les sources rapprochées d'un jeu, avec le nom de leur liste", async () => {
    const gameId = queryCatalog(db, {}).games[0].id
    await addSourceList(db, 'https://x/a.json', fetchOk({ ...LIST, name: 'Liste A' }))
    await addSourceList(db, 'https://x/b.json', fetchOk({ ...LIST, name: 'Liste B', entries: [{ ...LIST.entries[0], note: 'repack propre' }] }))

    const result = sourcesForGame(db, gameId)
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.listName).sort()).toEqual(['Liste A', 'Liste B'])
    expect(result[0].uris).toEqual(['https://x/smw.zip'])
  })

  it("jeu sans source : tableau vide", () => {
    const gameId = queryCatalog(db, {}).games[0].id
    expect(sourcesForGame(db, gameId)).toEqual([])
  })

  it("expose le titre brut de l'entrée, seul moyen de distinguer 2 entrées d'une même liste au même nom/poids", async () => {
    const gameId = queryCatalog(db, {}).games[0].id
    await addSourceList(db, 'https://x/list.json', fetchOk({
      ...LIST,
      entries: [
        { title: 'Super Mario World (Europe)', console: 'snes', uris: ['https://x/smw-eu.zip'] },
        { title: 'Super Mario World (USA)', console: 'snes', uris: ['https://x/smw-us.zip'] }
      ]
    }))
    const result = sourcesForGame(db, gameId)
    expect(result.map((s) => s.title).sort()).toEqual(['Super Mario World (Europe)', 'Super Mario World (USA)'])
  })
})

describe('queryCatalog — listes de sources associées', () => {
  it('liste les noms des listes ayant une entrée reconnue pour un jeu', async () => {
    await addSourceList(db, 'https://x/a.json', fetchOk({ ...LIST, name: 'Liste A' }))
    await addSourceList(db, 'https://x/b.json', fetchOk({ ...LIST, name: 'Liste B' }))
    const game = queryCatalog(db, {}).games[0]
    expect(game.sourceLists?.sort()).toEqual(['Liste A', 'Liste B'])
  })

  it('tableau vide pour un jeu sans source', () => {
    const game = queryCatalog(db, {}).games[0]
    expect(game.sourceLists).toEqual([])
  })
})

describe('queryCatalog — filtre par source', () => {
  beforeEach(() => {
    const row = (title: string) => ({ title, region: 'Europe', year: null, genre: null, developer: null, crc: null, sha1: null, size: null, variant: false })
    replaceConsole(db, 'snes', [row('Super Mario World (Europe)'), row('Zelda (Europe)')], null)
  })

  it('sans filtre sources, la facette est vide tant qu’aucune liste n’est ajoutée', () => {
    expect(queryCatalog(db, {}).sources).toEqual([])
  })

  it(`${SOURCE_FILTER_ANY} : ne garde que les jeux ayant au moins une source, toutes listes confondues`, async () => {
    await addSourceList(db, 'https://x/a.json', fetchOk({ ...LIST, name: 'Liste A' })) // ne reconnaît que Super Mario World
    const names = queryCatalog(db, { sources: [SOURCE_FILTER_ANY] }).games.map((g) => g.name)
    expect(names).toEqual(['Super Mario World'])
  })

  it('un id de liste précis ne garde que les jeux reconnus par CETTE liste', async () => {
    const a = await addSourceList(db, 'https://x/a.json', fetchOk({ ...LIST, name: 'Liste A' }))
    await addSourceList(db, 'https://x/b.json', fetchOk({ ...LIST, name: 'Liste B', entries: [{ title: 'Zelda', console: 'snes', uris: ['https://x/z.zip'] }] }))

    expect(queryCatalog(db, { sources: [String(a.listId)] }).games.map((g) => g.name)).toEqual(['Super Mario World'])
    expect(queryCatalog(db, { sources: ['999999'] }).games).toEqual([]) // id de liste inexistant : aucun résultat, pas une erreur
  })

  it('facette sources : une ligne par liste ayant un résultat, plus SOURCE_FILTER_ANY en tête', async () => {
    const a = await addSourceList(db, 'https://x/a.json', fetchOk({ ...LIST, name: 'Liste A' }))
    const page = queryCatalog(db, {})
    expect(page.sources).toEqual([
      { id: SOURCE_FILTER_ANY, name: '', count: 1 },
      { id: String(a.listId), name: 'Liste A', count: 1 }
    ])
  })

  it('la facette sources ignore son propre filtre (compte toutes les listes, pas seulement celle sélectionnée)', async () => {
    const a = await addSourceList(db, 'https://x/a.json', fetchOk({ ...LIST, name: 'Liste A' }))
    await addSourceList(db, 'https://x/b.json', fetchOk({ ...LIST, name: 'Liste B', entries: [{ title: 'Zelda', console: 'snes', uris: ['https://x/z.zip'] }] }))
    const page = queryCatalog(db, { sources: [String(a.listId)] })
    expect(page.sources.map((s) => s.name).sort()).toEqual(['', 'Liste A', 'Liste B'])
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
