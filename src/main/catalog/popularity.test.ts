import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { CONSOLES } from '@shared/consoles'
import { matchKey, syncPopularity } from './popularity'
import { platformYear, companyOf } from './igdb'
import { queryCatalog, replaceConsole } from './catalogStore'

describe('matchKey', () => {
  it('rapproche les conventions de nommage No-Intro et IGDB', () => {
    expect(matchKey('Legend of Zelda, The - A Link to the Past (USA)')).toBe(matchKey('The Legend of Zelda: A Link to the Past'))
    expect(matchKey('Pokémon Emerald (USA, Europe) (Rev 1)')).toBe(matchKey('Pokemon Emerald'))
  })
  it('ignore un mot d’état de dump 3DS accolé après les tags (pas un tag entre parenthèses)', () => {
    expect(matchKey('Pokemon Omega Ruby (Europe) (En,Ja,Fr,De,Es,It,Ko) (Rev 2) Decrypted')).toBe(matchKey('Pokemon Omega Ruby'))
    expect(matchKey('Some Game (USA) Trimmed')).toBe(matchKey('Some Game'))
  })
})

describe('consoles prises en charge', () => {
  it('chaque console a un identifiant IGDB et TheGamesDB, et un constructeur', () => {
    for (const c of CONSOLES) { expect(c.igdb, c.id).toBeGreaterThan(0); expect(c.tgdb, c.id).toBeGreaterThan(0); expect(['Nintendo', 'Sony']).toContain(c.maker) }
  })
  it('exclut les consoles sans émulateur prévu', () => {
    const ids = CONSOLES.map((c) => c.id)
    for (const x of ['genesis', 'saturn', 'dreamcast']) expect(ids).not.toContain(x)
  })
})

describe('données IGDB', () => {
  it('l’année est celle de la plateforme, pas la sortie PC d’origine', () => {
    const g = { name: 'Witcher', release_dates: [{ platform: 6, date: 1431993600 }, { platform: 130, date: 1572480000 }] }
    expect(platformYear(g, 130)).toBe(2019)
    expect(platformYear(g, 6)).toBe(2015)
    expect(platformYear(g, 7)).toBeNull()
  })
  it('développeur, à défaut éditeur', () => {
    expect(companyOf({ name: 'x', involved_companies: [{ developer: false, publisher: true, company: { name: 'Pub' } }] })).toBe('Pub')
    expect(companyOf({ name: 'x', involved_companies: [{ developer: false, publisher: true, company: { name: 'Pub' } }, { developer: true, publisher: false, company: { name: 'Dev' } }] })).toBe('Dev')
  })
})

describe('syncPopularity', () => {
  const settings = { ...DEFAULT_SETTINGS, igdbClientId: 'id', igdbClientSecret: 's' }
  const fakeFetch = (async () => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))) as typeof fetch
  const row = (title: string, o = {}) => ({ title, region: 'Europe', year: null, genre: null, developer: null, crc: null, sha1: null, size: null, variant: false, ...o })
  const setup = (): DatabaseSync => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    replaceConsole(db, 'snes', [row('Aaa Obscure (Europe)'), row('Super Mario World (Europe)'), row('Already Known (Europe)', { genre: 'Puzzle', year: 1994, developer: 'DatDev' })], null)
    return db
  }
  const query = (async (_s: unknown, _t: string, body: string) => body.includes('(19)') ? [
    { name: 'Super Mario World', total_rating_count: 900, genres: [{ name: 'Adventure' }, { name: 'Platform' }], involved_companies: [{ developer: true, publisher: false, company: { name: 'Nintendo' } }], release_dates: [{ platform: 19, date: 662688000 }] },
    { name: 'Already Known', total_rating_count: 5, genres: [{ name: 'Shooter' }], release_dates: [{ platform: 19, date: 946684800 }] }
  ] : []) as never

  it('classe, complète genre/développeur/année, sans écraser les données des DAT', async () => {
    const db = setup()
    const realFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try { expect(await syncPopularity(db, settings, undefined, query)).toBe(2) } finally { globalThis.fetch = realFetch }
    const byName = Object.fromEntries(queryCatalog(db, { limit: 10 }).games.map((g) => [g.name, g]))
    expect(byName['Super Mario World']).toMatchObject({ popularity: 900, genre: 'platform', developer: 'Nintendo', year: 1991 })
    expect(byName['Already Known']).toMatchObject({ genre: 'puzzle', year: 1994, developer: 'DatDev' })
    expect(queryCatalog(db, { sort: 'popularity' }).games[0].name).toBe('Super Mario World')
  })
  it('les données IGDB survivent à une nouvelle synchronisation du DAT', async () => {
    const db = setup()
    const realFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    try { await syncPopularity(db, settings, undefined, query) } finally { globalThis.fetch = realFetch }
    replaceConsole(db, 'snes', [row('Super Mario World (Europe)')], null)
    expect(queryCatalog(db, {}).games[0]).toMatchObject({ popularity: 900, genre: 'platform', developer: 'Nintendo', year: 1991 })
  })
  it('trie dans les deux sens, valeurs inconnues toujours en dernier', () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    replaceConsole(db, 'snes', [row('B', { year: 2000 }), row('A', { year: 1990 }), row('C')], null)
    expect(queryCatalog(db, { sort: 'year', dir: 'asc' }).games.map((g) => g.name)).toEqual(['A', 'B', 'C'])
    expect(queryCatalog(db, { sort: 'year', dir: 'desc' }).games.map((g) => g.name)).toEqual(['B', 'A', 'C'])
    expect(queryCatalog(db, { sort: 'title', dir: 'desc' }).games.map((g) => g.name)).toEqual(['C', 'B', 'A'])
  })
})
