import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import { pcSearchTerm } from '@shared/pcMeta'
import { upsertExternalEntry } from './external'
import { listLibrary, removeEntry } from './libraryStore'
import { readCustomArt, resolveCustomArtPath } from './customArt'
import { findOnIgdb, getPcMeta, identifyEntry, identifyPending, pendingEntries, type IdentifyDeps, type PcQuery } from './pcMeta'

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kpc-')); db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

// PNG 1x1
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const row = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, total_rating_count: 10, summary: `Résumé de ${name}`, first_release_date: 1_500_000_000, genres: [{ name: 'Adventure' }, { name: 'Survival' }],
  involved_companies: [{ developer: false, publisher: true, company: { name: 'Éditeur' } }, { developer: true, publisher: false, company: { name: 'Studio' } }],
  cover: { image_id: 'co1abc' }, videos: [{ video_id: 'abcDEF12345', name: 'Launch Trailer' }], screenshots: [{ image_id: 'sc1abc' }], artworks: [{ image_id: 'ar1abc' }], ...extra
})
const deps = (query: PcQuery, over: Partial<IdentifyDeps> = {}): IdentifyDeps => ({ query, download: async () => PNG, dataDir: dir, now: 1_000, ...over })
const add = (title: string, source: 'steam' | 'gog' | 'manual' = 'steam', nativeId: string | null = '264710'): number => {
  const r = upsertExternalEntry(db, { kind: source === 'manual' ? 'exe' : 'launcher', source, nativeId, title, launch: source === 'manual' ? { type: 'exe', exe: `C:\\jeux\\${title}.exe` } : { type: 'uri', uri: `steam://rungameid/${nativeId}`, installDir: `C:\\jeux\\${title}` } })
  if (!r.ok) throw new Error('add')
  return r.id
}

describe('pcSearchTerm', () => {
  it('retire marques, éditions et parenthèses', () => {
    expect(pcSearchTerm('RollerCoaster Tycoon World™')).toBe('RollerCoaster Tycoon World')
    expect(pcSearchTerm('Map Map - A Game About Maps Demo')).toBe('Map Map - A Game About Maps')
    expect(pcSearchTerm('Jeu (Steam Edition) [x64]')).toBe('Jeu')
    expect(pcSearchTerm('Zelda - Demo')).toBe('Zelda')
    expect(pcSearchTerm('A "quoted" \\ name')).toBe('A quoted name')
  })
})

describe('findOnIgdb', () => {
  it('Steam : retrouve le jeu par appid, nom contrôlé', async () => {
    const bodies: string[] = []
    const q: PcQuery = async (b) => { bodies.push(b); return [row('Subnautica')] as never }
    const f = await findOnIgdb({ title: 'Subnautica', source: 'steam', nativeId: '264710' }, q)
    expect(f).toMatchObject({ name: 'Subnautica', year: 2017, developer: 'Studio', genres: ['Adventure', 'Survival'], coverId: 'co1abc' })
    expect(f?.media).toEqual({ trailers: [{ id: 'abcDEF12345', name: 'Launch Trailer' }], screenshots: ['sc1abc'], artworks: ['ar1abc'] })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('external_games.uid = "264710"')
  })
  it('un appid qui désigne un autre jeu est ignoré : repli sur le titre', async () => {
    const bodies: string[] = []
    const q: PcQuery = async (b) => { bodies.push(b); return (b.startsWith('search') ? [row('Subnautica')] : [row('Tout autre chose')]) as never }
    expect((await findOnIgdb({ title: 'Subnautica', source: 'steam', nativeId: '1' }, q))?.name).toBe('Subnautica')
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toContain('platforms = (6)')
  })
  it('titre : nom identique exigé, jamais le premier résultat', async () => {
    const q: PcQuery = async () => [row('Subnautica: Below Zero'), row('Subnautica Mod')] as never
    expect(await findOnIgdb({ title: 'Subnautica', source: 'gog', nativeId: '1' }, q)).toBeNull()
    const q2: PcQuery = async () => [row('Subnautica: Below Zero'), row('Subnautica', { total_rating_count: 5 }), row('SUBNAUTICA', { total_rating_count: 50 })] as never
    expect((await findOnIgdb({ title: 'Subnautica', source: 'gog', nativeId: '1' }, q2))?.name).toBe('SUBNAUTICA')
  })
  it('un titre de recherche explicite remplace celui de l’entrée', async () => {
    const q: PcQuery = async (b) => (b.includes('"Hades"') ? [row('Hades')] : []) as never
    expect((await findOnIgdb({ title: 'hades-win64', source: 'manual', nativeId: null }, q, 'Hades'))?.name).toBe('Hades')
  })
  it('identifiants d’image invalides ignorés', async () => {
    const q: PcQuery = async () => [row('X', { cover: { image_id: '../../etc' }, screenshots: [{ image_id: 'bad id' }] })] as never
    const f = await findOnIgdb({ title: 'X', source: 'gog', nativeId: '1' }, q)
    expect(f?.coverId).toBeNull(); expect(f?.media.screenshots).toEqual([])
  })
})

describe('identifyEntry', () => {
  it('enregistre la fiche et la jaquette, servie à la place d’une image absente', async () => {
    const id = add('Subnautica')
    const view = await identifyEntry(db, id, deps(async () => [row('Subnautica')] as never))
    expect(view).toMatchObject({ name: 'Subnautica', matched: true, details: { summary: 'Résumé de Subnautica', developer: 'Studio', releaseYear: 2017 } })
    const entry = listLibrary(db).find((e) => e.id === id)!
    expect(entry.art.cover).toMatch(/^pc\/\d+\/cover-1000\.png$/)
    expect(entry.overridden).toEqual([])
    expect(readFileSync(resolveCustomArtPath(dir, entry.art.cover!)!).equals(PNG)).toBe(true)
    expect((await readCustomArt(dir, entry.art.cover!))?.type).toBe('image/png')
    expect(getPcMeta(db, id)?.media?.trailers).toHaveLength(1)
  })
  it('une image personnelle l’emporte sur la jaquette trouvée', async () => {
    const id = add('Subnautica')
    await identifyEntry(db, id, deps(async () => [row('Subnautica')] as never))
    db.prepare("INSERT INTO library_overrides (entry_id, field, value, updated_at) VALUES (?, 'cover', ?, 0)").run(id, `${id}/cover-9.png`)
    const e = listLibrary(db).find((x) => x.id === id)!
    expect(e.art.cover).toBe(`${id}/cover-9.png`); expect(e.overridden).toEqual(['cover'])
  })
  it('sans résultat : mémorisé, retenté seulement après 24 h', async () => {
    const id = add('Jeu inconnu', 'gog', '9')
    expect(await identifyEntry(db, id, deps(async () => []))).toBeNull()
    expect(pendingEntries(db, 1_000 + 3600 * 1000)).toEqual([])
    expect(pendingEntries(db, 1_000 + 25 * 3600 * 1000)).toEqual([id])
  })
  it('réseau en panne : rien n’est mémorisé, l’entrée reste en attente', async () => {
    const id = add('Subnautica')
    expect(await identifyEntry(db, id, deps(async () => { throw new Error('réseau') }))).toBeNull()
    expect(pendingEntries(db)).toEqual([id])
  })
  it('jaquette illisible : la fiche est gardée sans image', async () => {
    const id = add('Subnautica')
    await identifyEntry(db, id, deps(async () => [row('Subnautica')] as never, { download: async () => Buffer.from('pas une image') }))
    expect(getPcMeta(db, id)).not.toBeNull()
    expect(listLibrary(db).find((e) => e.id === id)!.art.cover).toBeUndefined()
  })
  it('ne touche ni au titre, ni aux surcharges, ni aux ROM', async () => {
    const id = add('Subnautica')
    db.prepare("INSERT INTO library_overrides (entry_id, field, value, updated_at) VALUES (?, 'title', 'Mon titre', 0)").run(id)
    await identifyEntry(db, id, deps(async () => [row('Subnautica')] as never))
    expect(listLibrary(db).find((e) => e.id === id)).toMatchObject({ title: 'Subnautica', shownTitle: 'Mon titre' })
    const rom = Number(db.prepare("INSERT INTO library (console, title, path, size, match, added_at) VALUES ('snes', 'Z', 'p', 1, 'hash', 0)").run().lastInsertRowid)
    expect(await identifyEntry(db, rom, deps(async () => [row('Z')] as never))).toBeNull()
  })
  it('retirer l’entrée supprime sa fiche et sa jaquette', async () => {
    const id = add('Subnautica')
    await identifyEntry(db, id, deps(async () => [row('Subnautica')] as never))
    const art = listLibrary(db)[0].art.cover!
    await removeEntry(db, id, 'entry', dir, undefined, dir)
    expect(db.prepare('SELECT COUNT(*) AS n FROM pc_meta').get()).toEqual({ n: 0 })
    expect(existsSync(join(dir, 'pc-art', String(id)))).toBe(false)
    expect(resolveCustomArtPath(dir, art)).toBeNull()
  })
})

describe('identifyPending', () => {
  it('identifie les entrées en attente et signale chaque réussite', async () => {
    const a = add('Subnautica'); add('Introuvable', 'gog', '2'); add('Hades', 'manual', null)
    let n = 0
    const q: PcQuery = async (b) => (b.includes('Subnautica') || b.includes('264710') ? [row('Subnautica')] : b.includes('"Hades"') ? [row('Hades')] : []) as never
    expect(await identifyPending(db, deps(q), () => { n++ })).toBe(2)
    expect(n).toBe(2)
    expect(getPcMeta(db, a)?.name).toBe('Subnautica')
    expect(pendingEntries(db, 2_000)).toEqual([])
  })
})
