import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { CONSOLES } from '@shared/consoles'
import { IGDB_PLATFORMS, matchKey, syncPopularity } from './popularity'
import { TGDB_PLATFORMS } from './tgdb'
import { queryCatalog } from './catalogStore'

describe('matchKey', () => {
  it('rapproche les conventions de nommage No-Intro et IGDB', () => {
    expect(matchKey('Legend of Zelda, The - A Link to the Past (USA)')).toBe(matchKey('The Legend of Zelda: A Link to the Past'))
    expect(matchKey('Pokémon Emerald (USA, Europe) (Rev 1)')).toBe(matchKey('Pokemon Emerald'))
  })
})

describe('consoles prises en charge', () => {
  it('chaque console du catalogue a un identifiant IGDB et TheGamesDB', () => {
    for (const c of CONSOLES) { expect(IGDB_PLATFORMS[c.id], c.id).toBeTypeOf('number'); expect(TGDB_PLATFORMS[c.id], c.id).toBeTypeOf('number') }
  })
  it('exclut les consoles sans émulateur prévu', () => {
    const ids = CONSOLES.map((c) => c.id)
    for (const x of ['genesis', 'saturn', 'dreamcast']) expect(ids).not.toContain(x)
  })
})

describe('syncPopularity', () => {
  it('note les jeux rapprochés et le tri popularité les place en tête', async () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    db.prepare("INSERT INTO catalog_games (console, title, region, genre) VALUES ('snes','Aaa Obscure (USA)','USA','RPG'),('snes','Super Mario World (USA)','USA','Platform')").run()
    const settings = { ...DEFAULT_SETTINGS, igdbClientId: 'id', igdbClientSecret: 's' }
    const fakeToken = async (): Promise<string> => 't'
    void fakeToken
    const query = (async (_s: unknown, _t: string, body: string) => body.includes('(19)') ? [{ name: 'Super Mario World', total_rating_count: 900 }] : []) as never
    // igdbToken appelle le réseau : on court-circuite en fournissant un jeton via un faux fetch.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch
    try { expect(await syncPopularity(db, settings, undefined, query)).toBe(1) } finally { globalThis.fetch = realFetch }
    expect(queryCatalog(db, { sort: 'popularity' }).games[0].title).toBe('Super Mario World (USA)')
  })
})
