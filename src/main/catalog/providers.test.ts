import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { CatalogGame } from '@shared/catalog'
import { getDetails, usedToday, type MetadataProvider } from './providers'
import { searchTerm } from './igdb'

const game: CatalogGame = { id: 1, console: 'snes', title: 'Zelda (USA)', region: 'USA', year: 1991, genre: null, developer: null, crc: null, sha1: null, size: null, popularity: null }
const setup = (): DatabaseSync => { const db = new DatabaseSync(':memory:'); migrate(db); return db }
const provider = (id: string, impl: MetadataProvider['fetchDetails'], limit = 10): MetadataProvider & { calls: number } => {
  const p = { id, dailyLimit: limit, calls: 0, isConfigured: () => true, fetchDetails: async (g: CatalogGame, s: typeof DEFAULT_SETTINGS) => { p.calls++; return impl(g, s) } }
  return p
}

describe('cascade', () => {
  it('saute un fournisseur en erreur et met le résultat en cache', async () => {
    const db = setup()
    const a = provider('a', async () => { throw new Error('boom') })
    const b = provider('b', async () => ({ provider: 'b', summary: 'ok' }))
    expect((await getDetails(db, game, [a, b], DEFAULT_SETTINGS))?.summary).toBe('ok')
    await getDetails(db, game, [a, b], DEFAULT_SETTINGS)
    expect(b.calls).toBe(1)
  })
  it('fusionne les champs : le premier fournisseur renseignant un champ gagne', async () => {
    const db = setup()
    const a = provider('a', async () => ({ summary: 'A', genres: [] }))
    const b = provider('b', async () => ({ summary: 'B', developer: 'Dev', heroUrl: 'http://x/h.png' }))
    expect(await getDetails(db, game, [a, b], DEFAULT_SETTINGS)).toMatchObject({ summary: 'A', developer: 'Dev', heroUrl: 'http://x/h.png', provider: 'a+b' })
  })
  it('respecte le quota quotidien', async () => {
    const db = setup()
    const a = provider('a', async () => null, 1)
    await getDetails(db, { ...game, id: 1 }, [a], DEFAULT_SETTINGS)
    await getDetails(db, { ...game, id: 2 }, [a], DEFAULT_SETTINGS)
    expect(a.calls).toBe(1)
    expect(usedToday(db, 'a')).toBe(1)
  })
  it('retient un échec 24 h sans re-solliciter', async () => {
    const db = setup()
    const a = provider('a', async () => null)
    await getDetails(db, game, [a], DEFAULT_SETTINGS)
    await getDetails(db, game, [a], DEFAULT_SETTINGS)
    expect(a.calls).toBe(1)
    await getDetails(db, game, [a], DEFAULT_SETTINGS, { refresh: true })
    expect(a.calls).toBe(2)
  })
})

describe('searchTerm', () => {
  it('retire régions et articles', () => {
    expect(searchTerm('Legend of Zelda, The - A Link to the Past (USA) (Rev 1)')).toBe('Legend of Zelda, The - A Link to the Past')
    expect(searchTerm('Ico, The (Europe)')).toBe('Ico')
  })
})
