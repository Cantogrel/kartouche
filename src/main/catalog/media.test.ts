import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { CatalogGame } from '@shared/catalog'
import { igdbImageUrl, isMediaId, pickImages, pickTrailers, youtubeEmbedUrl } from '@shared/media'
import { getMedia, type MediaQuery } from './media'
import { recordUse } from './providers'

const game = (id = 1, name = 'Zelda'): CatalogGame => ({ id, console: 'snes', title: `${name} (USA)`, region: 'USA', year: 1991, genre: null, developer: null, crc: null, sha1: null, size: null, popularity: null, name, img: null } as CatalogGame)
let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => db.close())

const rows = [
  { name: 'Zelda Mod', total_rating_count: 500, videos: [{ video_id: 'MODVIDEO001', name: 'Mod trailer' }] },
  { name: 'Zelda', total_rating_count: 40, videos: [{ video_id: 'abcDEF12345', name: 'Gameplay' }, { video_id: 'LAUNCH12345', name: 'Launch Trailer' }, { video_id: 'abcDEF12345', name: 'Doublon' }, { video_id: '../etc', name: 'Dangereux' }], screenshots: [{ image_id: 'sc1abc' }, { image_id: 'sc2def' }, { image_id: 'sc1abc' }, { image_id: 'bad id!' }], artworks: [{ image_id: 'ar1xyz' }] }
]
const counting = (answer: unknown[]): { query: MediaQuery; calls: string[] } => { const calls: string[] = []; return { calls, query: async (b) => { calls.push(b); return answer as never } } }

describe('getMedia', () => {
  it('choisit le jeu de même titre, classe les trailers, retire doublons et identifiants invalides', async () => {
    const q = counting(rows)
    const media = await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query })
    expect(media).toEqual({
      trailers: [{ id: 'LAUNCH12345', name: 'Launch Trailer' }, { id: 'abcDEF12345', name: 'Gameplay' }],
      screenshots: ['sc1abc', 'sc2def'],
      artworks: ['ar1xyz']
    })
    expect(q.calls[0]).toContain('search "Zelda"')
    expect(q.calls[0]).toContain('platforms = (19)') // SNES chez IGDB
    expect(q.calls[0]).toContain('videos.video_id')
  })

  it('met en cache : la 2e ouverture ne rappelle pas IGDB, l’actualisation et l’expiration oui', async () => {
    const q = counting(rows)
    const t0 = 1_000_000
    await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query, now: t0 })
    await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query, now: t0 + 1000 })
    expect(q.calls).toHaveLength(1)
    await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query, now: t0 + 2000, refresh: true })
    expect(q.calls).toHaveLength(2)
    await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query, now: t0 + 31 * 24 * 3600 * 1000 })
    expect(q.calls).toHaveLength(3)
  })

  it('un jeu sans média est retenu 24 h puis redemandé', async () => {
    const q = counting([{ name: 'Zelda' }])
    const t0 = 5_000_000
    expect(await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query, now: t0 })).toBeNull()
    expect(await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query, now: t0 + 3600_000 })).toBeNull()
    expect(q.calls).toHaveLength(1)
    await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query, now: t0 + 25 * 3600_000 })
    expect(q.calls).toHaveLength(2)
  })

  it('une erreur réseau ne met rien en cache : l’ouverture suivante réessaie', async () => {
    let n = 0
    const query: MediaQuery = async () => { n++; if (n === 1) throw new Error('réseau'); return rows as never }
    expect(await getMedia(db, game(), DEFAULT_SETTINGS, { query })).toBeNull()
    expect(await getMedia(db, game(), DEFAULT_SETTINGS, { query })).not.toBeNull()
    expect(n).toBe(2)
  })

  it('respecte le quota du jour et l’absence de configuration', async () => {
    const q = counting(rows)
    const now = Date.UTC(2026, 9, 5)
    for (let i = 0; i < 2000; i++) recordUse(db, 'igdb-media', now)
    expect(await getMedia(db, game(), DEFAULT_SETTINGS, { query: q.query, now })).toBeNull()
    expect(q.calls).toHaveLength(0)
    expect(await getMedia(db, game(), { ...DEFAULT_SETTINGS, igdbClientId: '' })).toBeNull() // sans clé ni proxy : silencieux, aucune requête réseau
  })

  it('le cache est propre à chaque jeu', async () => {
    const q = counting(rows)
    await getMedia(db, game(1), DEFAULT_SETTINGS, { query: q.query })
    await getMedia(db, game(2), DEFAULT_SETTINGS, { query: q.query })
    expect(q.calls).toHaveLength(2)
  })
})

describe('shared/media', () => {
  it('ne laisse passer que des identifiants sûrs et construit les adresses', () => {
    for (const ok of ['abcDEF12345', 'sc1abc', 'a-b_c-1']) expect(isMediaId(ok)).toBe(true)
    for (const bad of ['', 'ab', '../x', 'a b c d e', 'x'.repeat(40), 42, null]) expect(isMediaId(bad)).toBe(false)
    expect(igdbImageUrl('sc1abc')).toBe('https://images.igdb.com/igdb/image/upload/t_screenshot_big/sc1abc.jpg')
    expect(youtubeEmbedUrl('abcDEF12345', { autoplay: true })).toBe('https://www.youtube-nocookie.com/embed/abcDEF12345?rel=0&modestbranding=1&enablejsapi=1&autoplay=1')
  })

  it('pickTrailers garde 5 vidéos au plus et pickImages borne le nombre', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ video_id: `video${String(i).padStart(6, '0')}`, name: `Clip ${i}` }))
    expect(pickTrailers(many)).toHaveLength(5)
    expect(pickTrailers(undefined)).toEqual([])
    expect(pickImages(Array.from({ length: 30 }, (_, i) => ({ image_id: `img${String(i).padStart(4, '0')}` })))).toHaveLength(12)
  })
})
