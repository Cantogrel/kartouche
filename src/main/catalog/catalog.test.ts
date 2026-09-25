import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { catalogCount, getGame, queryCatalog } from './catalogStore'
import { syncCatalog } from './sync'

const setup = (): DatabaseSync => { const db = new DatabaseSync(':memory:'); migrate(db); return db }

describe('catalogue', () => {
  it('filtre, trie et calcule les facettes', async () => {
    const db = setup()
    await syncCatalog(db, ['snes', 'nes'], () => undefined, async (url) => (url.includes('genre') || url.includes('year') || url.includes('developer'))
      ? null : 'game (\n\tname "Alpha (USA)"\n\tregion "USA"\n\trom ( crc 1 )\n)\ngame (\n\tname "Beta (Europe) (Beta)"\n\trom ( crc 2 )\n)\n')
    expect(catalogCount(db)).toBe(4)
    const all = queryCatalog(db, {})
    expect(all.total).toBe(2) // variantes masquées
    expect(queryCatalog(db, { includeVariants: true }).total).toBe(4)
    expect(queryCatalog(db, { consoles: ['nes'] }).total).toBe(1)
    expect(all.consoles).toHaveLength(2)
  })
  it('cherche par mots et échappe les jokers LIKE', () => {
    const db = setup()
    db.prepare("INSERT INTO catalog_games (console, title, region) VALUES ('snes', '100% Orange Juice', ''), ('snes', 'Orange Star', '')").run()
    expect(queryCatalog(db, { q: '100%' }).total).toBe(1)
    expect(queryCatalog(db, { q: 'orange star' }).total).toBe(1)
    expect(queryCatalog(db, { q: '_' }).total).toBe(0)
  })
  it('facette genre ignore son propre filtre et trie par année', () => {
    const db = setup()
    db.prepare("INSERT INTO catalog_games (console, title, genre, year) VALUES ('snes','A','RPG',1990),('snes','B','Action',2000)").run()
    const p = queryCatalog(db, { genres: ['RPG'], sort: 'year' })
    expect(p.total).toBe(1)
    expect(p.genres.map((g) => g.name).sort()).toEqual(['Action', 'RPG'])
    expect(queryCatalog(db, { sort: 'year' }).games[0].title).toBe('B')
    expect(getGame(db, p.games[0].id)?.title).toBe('A')
  })
})
