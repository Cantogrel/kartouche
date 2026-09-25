import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { catalogCount, getGame, queryCatalog } from './catalogStore'
import { syncCatalog } from './sync'

const setup = (): DatabaseSync => { const db = new DatabaseSync(':memory:'); migrate(db); return db }
const entry = (name: string, region: string, crc: number): string => `game (\n\tname "${name}"\n\tregion "${region}"\n\trom ( crc ${crc} )\n)\n`
const noMeta = (dat: string) => async (url: string): Promise<string | null> => (/genre|year|developer/.test(url) ? null : dat)

describe('catalogue', () => {
  it('filtre, trie et calcule les facettes', async () => {
    const db = setup()
    await syncCatalog(db, ['snes', 'nes'], () => undefined, noMeta(entry('Alpha (USA)', 'USA', 1) + entry('Beta (Europe) (Beta)', 'Europe', 2)))
    expect(catalogCount(db)).toBe(4)
    const all = queryCatalog(db, {})
    expect(all.total).toBe(2) // variantes masquées
    expect(queryCatalog(db, { includeVariants: true }).total).toBe(4)
    expect(queryCatalog(db, { consoles: ['nes'] }).total).toBe(1)
    expect(all.consoles).toHaveLength(2)
  })
  it('regroupe régions et révisions : une seule entrée par jeu, Europe d’abord', async () => {
    const db = setup()
    await syncCatalog(db, ['snes'], () => undefined,
      noMeta(entry('Zelda, The (Europe)', 'Europe', 1) + entry('Zelda, The (USA)', 'USA', 2) + entry('Zelda, The (USA) (Rev 1)', 'USA', 3)))
    expect(queryCatalog(db, {}).games.map((x) => x.title)).toEqual(['Zelda, The (Europe)'])
    expect(queryCatalog(db, { includeVariants: true }).total).toBe(3)
  })
  it('cherche le titre lisible : « the legend of zelda » trouve « Legend of Zelda, The »', async () => {
    const db = setup()
    await syncCatalog(db, ['snes'], () => undefined, noMeta(entry('Legend of Zelda, The - A Link to the Past (USA)', 'USA', 1)))
    const p = queryCatalog(db, { q: 'the legend of zelda' })
    expect(p.games.map((g) => g.name)).toEqual(['The Legend of Zelda - A Link to the Past'])
  })
  it('cherche par mots et échappe les jokers LIKE', () => {
    const db = setup()
    db.prepare("INSERT INTO catalog_games (console, title, name, region) VALUES ('snes', '100% Orange Juice', '100% Orange Juice', ''), ('snes', 'Orange Star', 'Orange Star', '')").run()
    expect(queryCatalog(db, { q: '100%' }).total).toBe(1)
    expect(queryCatalog(db, { q: 'orange star' }).total).toBe(1)
    expect(queryCatalog(db, { q: '_' }).total).toBe(0)
  })
  it('facette genre ignore son propre filtre et trie par année', () => {
    const db = setup()
    db.prepare("INSERT INTO catalog_games (console, title, name, genre, year) VALUES ('snes','A','A','RPG',1990),('snes','B','B','Action',2000)").run()
    const p = queryCatalog(db, { genres: ['RPG'], sort: 'year' })
    expect(p.total).toBe(1)
    expect(p.genres.map((g) => g.name).sort()).toEqual(['Action', 'RPG'])
    expect(queryCatalog(db, { sort: 'year' }).games[0].title).toBe('B')
    expect(getGame(db, p.games[0].id)?.title).toBe('A')
  })
})
