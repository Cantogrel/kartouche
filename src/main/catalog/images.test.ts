import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { displayTitle, type CatalogGame } from '@shared/catalog'
import { cachedImage, sgdbId, sniff } from './images'
import { fetchSwitchCatalog } from './switch'
import { syncCatalog } from './sync'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { queryCatalog } from './catalogStore'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

describe('displayTitle', () => {
  it('retire région, langues et révision et remet l’article devant', () => {
    expect(displayTitle('Legend of Zelda, The - A Link to the Past (USA) (Rev 1)')).toBe('The Legend of Zelda - A Link to the Past')
    expect(displayTitle('Grand Theft Auto V (Europe, Australia) (En,Fr,De,Es,It,Pt,Pl,Ru)')).toBe('Grand Theft Auto V')
    expect(displayTitle('Elder Scrolls V, The - Skyrim (USA, Asia) (En,Fr,Es)')).toBe('The Elder Scrolls V - Skyrim')
  })
})

describe('cachedImage', () => {
  it('essaie les sources dans l’ordre et mémorise la première image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-img-'))
    let calls = 0
    const src = [async () => { calls++; return null }, async () => { calls++; return PNG }, async () => { calls++; return null }]
    expect(sniff((await cachedImage(dir, '1', src))!.data)).toBe('image/png')
    expect(calls).toBe(2)
    await cachedImage(dir, '1', src)
    expect(calls).toBe(2) // servi depuis le disque
  })
  it('retient l’absence d’image, mais pas une panne réseau', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-img-'))
    let calls = 0
    expect(await cachedImage(dir, '2', [async () => { calls++; throw new Error('offline') }])).toBeNull()
    expect(readdirSync(dir)).toEqual([]) // rien retenu
    expect(await cachedImage(dir, '3', [async () => { calls++; return null }])).toBeNull()
    expect(await cachedImage(dir, '3', [async () => { calls++; return PNG }])).toBeNull() // marqueur d’absence
    expect(calls).toBe(2)
  })
})

describe('sgdbId', () => {
  const game = (name: string): CatalogGame => ({ id: 1, console: 'gb', title: name, name, region: 'France', year: null, genre: null, developer: null, crc: null, sha1: null, size: null, popularity: null, img: null })
  const withFetch = async (data: unknown, run: () => Promise<void>): Promise<void> => {
    const real = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ data }))) as typeof fetch
    try { await run() } finally { globalThis.fetch = real }
  }
  // Bug vécu : Pokémon Jaune (titre français, absent tel quel de SteamGridDB) se voyait attribuer la jaquette de
  // Pokémon Rouge, premier résultat de l'autocomplete pour une franchise à plusieurs entrées très proches.
  it("ne retient pas le premier résultat de l'autocomplete si aucun ne correspond au nom recherché (autre jeu de la même franchise)", async () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    await withFetch([{ id: 999, name: 'Pokemon Red Version' }], async () => {
      expect(await sgdbId(db, game('Pokemon - Version Jaune - Edition Speciale Pikachu'), 'k')).toBeNull()
    })
  })
  it('ignore accents/ponctuation/casse pour reconnaître un vrai match', async () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    await withFetch([{ id: 42, name: 'Pokémon: Yellow Version' }], async () => {
      expect(await sgdbId(db, game('Pokemon - Yellow Version'), 'k')).toBe(42)
    })
  })
})

describe('catalogue Switch (IGDB)', () => {
  const fake = (async () => [
    { name: 'Zelda Breath', release_dates: [{ platform: 6, date: 1300000000 }, { platform: 130, date: 1488499200 }], total_rating_count: 900, genres: [{ name: 'Adventure' }, { name: 'Role-playing (RPG)' }], involved_companies: [{ developer: true, company: { name: 'Nintendo' } }], artworks: [{ image_id: 'art1' }] },
    { name: 'Zelda Breath', total_rating_count: 5 }
  ]) as never
  it('construit les lignes avec score et image, sans doublon de nom', async () => {
    const rows = await fetchSwitchCatalog({ ...DEFAULT_SETTINGS, igdbClientId: 'i', igdbClientSecret: 's' }, fake, 't')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Zelda Breath', year: 2017, genre: 'rpg', developer: 'Nintendo', popularity: 900, img: 'art1' })
  })
  it('est sauté sans clé IGDB, inclus avec', async () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    const get = async (): Promise<string | null> => null
    const r1 = await syncCatalog(db, ['switch'], () => undefined, get, DEFAULT_SETTINGS, fake)
    expect(r1.synced).toBe(0)
    const s = { ...DEFAULT_SETTINGS, igdbClientId: 'i', igdbClientSecret: 's' }
    const r2 = await syncCatalog(db, ['switch'], () => undefined, get, s, async () => fetchSwitchCatalog(s, fake, 't'))
    expect(r2.synced).toBe(1)
    expect(queryCatalog(db, { consoles: ['switch'], sort: 'popularity' }).games[0]).toMatchObject({ name: 'Zelda Breath', img: 'art1' })
  })
})
