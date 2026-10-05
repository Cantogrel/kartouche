import type { DatabaseSync } from 'node:sqlite'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '@shared/settings'
import { igdbImageUrl, pickImages, pickTrailers, type GameMedia } from '@shared/media'
import { pcSearchTerm, type PcMetaView } from '@shared/pcMeta'
import { igdbQuery, igdbToken, platformYear, type IgdbRow } from '../catalog/igdb'
import { matchKey } from '../catalog/popularity'
import { sniffImage } from './customArt'

/*
 * Identification des jeux PC (exécutables ajoutés, jeux de launchers) sur IGDB : description, genre, année, développeur, bande-annonce, captures et
 * jaquette. Un jeu Steam est retrouvé par son appid (exact) ; les autres par leur titre, sur la plateforme PC, avec un nom identique (jamais « le premier
 * résultat »). Les résultats sont l'ORIGINE affichée sous les surcharges de l'utilisateur ; ce module n'importe donc jamais overrides.ts, et seul le titre
 * d'origine de l'entrée sert à chercher. La jaquette est enregistrée dans `<data>/pc-art/<entrée>/cover.<ext>`.
 */

const IGDB_PC = 6
const RETRY_MISS_MS = 24 * 3600 * 1000
const FIELDS = 'name,total_rating_count,summary,first_release_date,genres.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,cover.image_id,' +
  'videos.video_id,videos.name,screenshots.image_id,artworks.image_id'

interface Row extends IgdbRow {
  first_release_date?: number
  cover?: { image_id?: string }
  videos?: { video_id?: string; name?: string }[]
  screenshots?: { image_id?: string }[]
  artworks?: { image_id?: string }[]
}

export type PcQuery = (body: string) => Promise<Row[]>
export type DownloadImage = (url: string) => Promise<Buffer | null>

export const pcArtDir = (dataDir: string): string => join(dataDir, 'pc-art')

export interface Identified {
  name: string
  summary: string | null
  genres: string[]
  year: number | null
  developer: string | null
  media: GameMedia
  coverId: string | null
}

const pick = (rows: Row[], term: string): Row | undefined => {
  const want = matchKey(term)
  return rows.filter((r) => matchKey(r.name) === want).sort((a, b) => (b.total_rating_count ?? 0) - (a.total_rating_count ?? 0))[0]
}

/** Cherche le jeu sur IGDB : par appid Steam d'abord (exact, nom contrôlé), puis par titre sur PC. null si rien de sûr. */
export async function findOnIgdb(entry: { title: string; source: string | null; nativeId: string | null }, query: PcQuery, titleOverride?: string): Promise<Identified | null> {
  const term = pcSearchTerm(titleOverride ?? entry.title)
  let g: Row | undefined
  if (!titleOverride && entry.source === 'steam' && entry.nativeId && /^\d+$/.test(entry.nativeId)) {
    const rows = await query(`fields ${FIELDS}; where external_games.uid = "${entry.nativeId}"; limit 5;`)
    // L'uid peut exister chez un autre magasin : on garde le résultat dont le nom ressemble au titre.
    const want = matchKey(term)
    g = rows.find((r) => { const k = matchKey(r.name); return k === want || (want.length >= 4 && (k.startsWith(want) || want.startsWith(k))) })
  }
  if (!g && term) {
    const rows = await query(`search "${term}"; where platforms = (${IGDB_PC}); fields ${FIELDS}; limit 10;`)
    g = pick(rows, term)
  }
  if (!g) return null
  const role = (r: 'developer' | 'publisher'): string | null => g!.involved_companies?.find((c) => c[r])?.company.name ?? null
  const date = g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : platformYear(g, IGDB_PC)
  return {
    name: g.name, summary: g.summary?.trim() || null, genres: (g.genres ?? []).map((x) => x.name).slice(0, 4), year: date, developer: role('developer') ?? role('publisher'),
    media: { trailers: pickTrailers(g.videos), screenshots: pickImages(g.screenshots), artworks: pickImages(g.artworks, 6) },
    coverId: g.cover?.image_id && /^[A-Za-z0-9_-]{5,24}$/.test(g.cover.image_id) ? g.cover.image_id : null
  }
}

export interface IdentifyDeps { query: PcQuery; download: DownloadImage; dataDir: string; now?: number }

export const realDeps = (settings: Settings, dataDir: string): IdentifyDeps => ({
  dataDir,
  query: async (body) => igdbQuery<Row>(settings, await igdbToken(settings), body),
  download: async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length > 0 && buf.length < 10 * 1024 * 1024 ? buf : null
    } catch { return null }
  }
})

interface EntryRow { id: number; title: string; source: string | null; native_id: string | null }

/** Identifie une entrée non-ROM et enregistre la fiche (et la jaquette). Renvoie la fiche, ou null si le jeu n'a pas été reconnu ; l'échec est mémorisé. */
export async function identifyEntry(db: DatabaseSync, entryId: number, deps: IdentifyDeps, titleOverride?: string): Promise<PcMetaView | null> {
  const e = db.prepare("SELECT id, title, source, native_id FROM library WHERE id = ? AND kind <> 'rom'").get(entryId) as unknown as EntryRow | undefined
  if (!e) return null
  const now = deps.now ?? Date.now()
  let found: Identified | null
  try { found = await findOnIgdb({ title: e.title, source: e.source, nativeId: e.native_id }, deps.query, titleOverride) } catch { return null } // réseau : on réessaiera, rien n'est mémorisé
  if (!found) {
    db.prepare('INSERT INTO pc_meta (entry_id, matched, fetched_at) VALUES (?, 0, ?) ON CONFLICT(entry_id) DO UPDATE SET matched = 0, name = NULL, summary = NULL, genres = NULL, year = NULL, developer = NULL, media = NULL, cover = NULL, fetched_at = excluded.fetched_at').run(entryId, now)
    await rm(join(pcArtDir(deps.dataDir), String(entryId)), { recursive: true, force: true })
    return null
  }
  let cover: string | null = null
  if (found.coverId) {
    const img = await deps.download(igdbImageUrl(found.coverId, 't_cover_big'))
    const kind = img ? sniffImage(img) : null
    if (img && kind) {
      const dir = join(pcArtDir(deps.dataDir), String(entryId))
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const file = `cover-${now}.${kind}`
      await writeFile(join(dir, file), img)
      cover = `pc/${entryId}/${file}`
    }
  }
  db.prepare(`INSERT INTO pc_meta (entry_id, matched, name, summary, genres, year, developer, media, cover, fetched_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET matched = 1, name = excluded.name, summary = excluded.summary, genres = excluded.genres, year = excluded.year, developer = excluded.developer,
      media = excluded.media, cover = excluded.cover, fetched_at = excluded.fetched_at`)
    .run(entryId, found.name, found.summary, JSON.stringify(found.genres), found.year, found.developer, JSON.stringify(found.media), cover, now)
  return getPcMeta(db, entryId)
}

/** Entrées non-ROM jamais identifiées, ou non reconnues il y a plus de 24 h. */
export function pendingEntries(db: DatabaseSync, now = Date.now()): number[] {
  return (db.prepare(`SELECT l.id FROM library l LEFT JOIN pc_meta m ON m.entry_id = l.id
    WHERE l.kind <> 'rom' AND (m.entry_id IS NULL OR (m.matched = 0 AND m.fetched_at < ?)) ORDER BY l.id`).all(now - RETRY_MISS_MS) as { id: number }[]).map((r) => r.id)
}

/** Identifie toutes les entrées en attente, une par une (IGDB espace déjà ses appels) ; appelle `onProgress` après chaque entrée reconnue. */
export async function identifyPending(db: DatabaseSync, deps: IdentifyDeps, onProgress?: () => void): Promise<number> {
  let found = 0
  for (const id of pendingEntries(db, deps.now)) {
    const r = await identifyEntry(db, id, deps)
    if (r) { found++; onProgress?.() }
  }
  return found
}

interface MetaRow { name: string | null; summary: string | null; genres: string | null; year: number | null; developer: string | null; media: string | null; matched: number }

export function getPcMeta(db: DatabaseSync, entryId: number): PcMetaView | null {
  const r = db.prepare('SELECT name, summary, genres, year, developer, media, matched FROM pc_meta WHERE entry_id = ?').get(entryId) as unknown as MetaRow | undefined
  if (!r || r.matched !== 1 || !r.name) return null
  const parse = <T>(s: string | null): T | null => { try { return s ? JSON.parse(s) as T : null } catch { return null } }
  return {
    name: r.name, matched: true,
    details: { summary: r.summary ?? undefined, developer: r.developer ?? undefined, releaseYear: r.year ?? undefined, genres: parse<string[]>(r.genres) ?? undefined },
    media: parse<GameMedia>(r.media)
  }
}

/** Jaquette de chaque entrée identifiée (id → chemin relatif servi par `kimg://custom/pc/…`). */
export function loadPcCovers(db: DatabaseSync): Map<number, string> {
  const out = new Map<number, string>()
  for (const r of db.prepare('SELECT entry_id, cover FROM pc_meta WHERE cover IS NOT NULL').all() as { entry_id: number; cover: string }[]) out.set(r.entry_id, r.cover)
  return out
}

export async function removePcArt(dataDir: string, entryId: number): Promise<void> {
  await rm(join(pcArtDir(dataDir), String(entryId)), { recursive: true, force: true })
}
