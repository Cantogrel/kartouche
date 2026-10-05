import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import { upsertExternalEntry } from './external'
import { listLibrary } from './libraryStore'
import { backfillBanners, identifyEntry, type IdentifyDeps, type PcQuery } from './pcMeta'

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kban-')); db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const game = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'Subnautica', total_rating_count: 10, cover: { image_id: 'co1abc' }, screenshots: [{ image_id: 'sc1abc' }], artworks: [{ image_id: 'ar1abc' }], ...extra })
const deps = (over: Partial<IdentifyDeps> = {}): IdentifyDeps => ({ query: (async () => [game()]) as unknown as PcQuery, download: async () => PNG, dataDir: dir, now: 1_000, ...over })
const add = (title: string): number => {
  const r = upsertExternalEntry(db, { kind: 'launcher', source: 'steam', nativeId: '1', title, launch: { type: 'uri', uri: 'steam://rungameid/1' } })
  if (!r.ok) throw new Error('add')
  return r.id
}

describe('bannière des jeux PC', () => {
  it('prend la première illustration IGDB et la range dans art.banner', async () => {
    const urls: string[] = []
    const id = add('Subnautica')
    await identifyEntry(db, id, deps({ download: async (u) => { urls.push(u); return PNG } }))
    expect(listLibrary(db).find((e) => e.id === id)!.art.banner).toMatch(/^pc\/\d+\/banner-1000\.png$/)
    expect(urls.some((u) => u.includes('ar1abc') && u.includes('t_1080p'))).toBe(true)
  })
  it('à défaut d’illustration, une capture d’écran', async () => {
    const urls: string[] = []
    const id = add('Subnautica')
    await identifyEntry(db, id, deps({ query: (async () => [game({ artworks: [] })]) as unknown as PcQuery, download: async (u) => { urls.push(u); return PNG } }))
    expect(urls.some((u) => u.includes('sc1abc'))).toBe(true)
    expect(listLibrary(db)[0].art.banner).toBeTruthy()
  })
  it('rattrape les jeux identifiés avant les bannières, sans nouvelle requête IGDB', async () => {
    const id = add('Subnautica')
    await identifyEntry(db, id, deps())
    db.prepare('UPDATE pc_meta SET banner = NULL WHERE entry_id = ?').run(id)
    expect(listLibrary(db)[0].art.banner).toBeUndefined()
    let queries = 0
    const n = await backfillBanners(db, deps({ query: (async () => { queries++; return [] }) as unknown as PcQuery, now: 2_000 }))
    expect(n).toBe(1)
    expect(queries).toBe(0)
    expect(listLibrary(db)[0].art.banner).toMatch(/banner-2000\.png$/)
    expect(await backfillBanners(db, deps())).toBe(0) // déjà fait : rien à refaire
  })
  it('sans image disponible : pas de bannière, et on ne réessaie pas', async () => {
    const id = add('Subnautica')
    await identifyEntry(db, id, deps({ query: (async () => [game({ artworks: [], screenshots: [] })]) as unknown as PcQuery }))
    expect(listLibrary(db)[0].art.banner).toBeUndefined()
    expect(await backfillBanners(db, deps())).toBe(0)
  })
})
