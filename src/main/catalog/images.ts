import type { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleById } from '@shared/consoles'
import type { CatalogGame } from '@shared/catalog'
import type { Settings } from '@shared/settings'
import { thumbnailUrl } from './libretro'
import { igdbQuery, igdbToken, searchTerm } from './igdb'
import { recordUse, usedToday } from './providers'

/** `card` : vignette de liste ; `hero` : grande bannière de la fiche (les deux préfèrent le format horizontal) ; `icon` : icône carrée du jeu (menu latéral). */
export type ImageKind = 'card' | 'hero' | 'icon'
export interface Img { data: Buffer; type: string }

/** Une source renvoie null si elle n'a pas d'image ; elle lève une erreur si le réseau est indisponible (rien n'est alors retenu). */
export type ImageSource = () => Promise<Buffer | null>

const MISS_TTL_MS = 7 * 24 * 3600 * 1000

export function sniff(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return ''
}

async function fetchImage(url: string, headers?: Record<string, string>): Promise<Buffer | null> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) return null
  const b = Buffer.from(await res.arrayBuffer())
  return sniff(b) ? b : null
}

/**
 * Cache disque : `<dir>/<key>.img`, et `<key>.miss` (7 jours) quand aucune source n'a d'image.
 * Les sources sont essayées dans l'ordre ; la première qui répond est mémorisée.
 */
export async function cachedImage(dir: string, key: string, sources: ImageSource[]): Promise<Img | null> {
  const file = join(dir, `${key}.img`)
  try { const data = await readFile(file); return { data, type: sniff(data) } } catch { /* pas en cache */ }
  const miss = join(dir, `${key}.miss`)
  try { if (Date.now() - (await stat(miss)).mtimeMs < MISS_TTL_MS) return null } catch { /* pas de marqueur */ }
  for (const source of sources) {
    let data: Buffer | null
    try { data = await source() } catch { return null }
    if (data) {
      await mkdir(dir, { recursive: true })
      await writeFile(file, data)
      return { data, type: sniff(data) }
    }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(miss, '')
  return null
}

const SGDB = 'https://www.steamgriddb.com/api/v2'
const IMG_LIMIT = 4000

/** Appels réseau limités à 4 en parallèle : une page de catalogue déclenche des dizaines de résolutions d'images. */
const queue: (() => void)[] = []
let running = 0
export async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 4) await new Promise<void>((r) => queue.push(r))
  running++
  try { return await fn() } finally { running--; queue.shift()?.() }
}

async function sgdbApi<T>(db: DatabaseSync, path: string, key: string): Promise<T | null> {
  if (usedToday(db, 'sgdb-img') >= IMG_LIMIT) return null
  recordUse(db, 'sgdb-img', Date.now())
  const res = await fetch(`${SGDB}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) return null
  return ((await res.json()) as { data: T }).data
}

/** Identifiant SteamGridDB du jeu (recherche par nom), mémorisé y compris quand il n'y en a pas. */
async function sgdbId(db: DatabaseSync, game: CatalogGame, key: string): Promise<number | null> {
  const row = db.prepare("SELECT json FROM game_meta WHERE game_id = ? AND provider = 'sgdb-id'").get(game.id) as { json: string } | undefined
  if (row) return (JSON.parse(row.json) as { id: number | null }).id
  const term = searchTerm(game.name)
  const found = term ? await sgdbApi<{ id: number; name: string }[]>(db, `/search/autocomplete/${encodeURIComponent(term)}`, key) : null
  if (found === null) throw new Error('SteamGridDB indisponible')
  const hit = found.find((f) => f.name.toLowerCase() === term.toLowerCase()) ?? found[0]
  db.prepare("INSERT OR REPLACE INTO game_meta (game_id, provider, json, fetched_at) VALUES (?, 'sgdb-id', ?, ?)").run(game.id, JSON.stringify({ id: hit?.id ?? null }), Date.now())
  return hit?.id ?? null
}

const sgdbSource = (db: DatabaseSync, game: CatalogGame, s: Settings, kind: 'grids' | 'heroes' | 'icons'): ImageSource => async () => {
  if (!s.sgdbApiKey) return null
  const id = await sgdbId(db, game, s.sgdbApiKey)
  if (id === null) return null
  const q = kind === 'grids' ? '?dimensions=460x215,920x430&limit=1' : kind === 'icons' ? '?mimes=image/png&limit=1' : '?limit=1'
  const list = await sgdbApi<{ url: string }[]>(db, `/${kind}/game/${id}${q}`, s.sgdbApiKey)
  return list?.[0] ? fetchImage(list[0].url) : null
}

const igdbUrl = (imageId: string, size: 't_screenshot_big' | 't_1080p'): string => `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg`

/** Illustration IGDB : celle mémorisée au moment de la synchro (Switch), sinon recherche par nom sur la plateforme du jeu. */
const igdbSource = (db: DatabaseSync, game: CatalogGame, s: Settings, size: 't_screenshot_big' | 't_1080p'): ImageSource => async () => {
  if (game.img) return fetchImage(igdbUrl(game.img, size))
  const platform = consoleById(game.console)?.igdb
  if (!s.igdbClientId || !s.igdbClientSecret || !platform || usedToday(db, 'igdb-img') >= IMG_LIMIT) return null
  recordUse(db, 'igdb-img', Date.now())
  const term = searchTerm(game.name).replace(/["\\]/g, ' ')
  const [g] = await igdbQuery<{ artworks?: { image_id: string }[]; screenshots?: { image_id: string }[] }>(s, await igdbToken(s),
    `search "${term}"; where platforms = (${platform}); fields artworks.image_id,screenshots.image_id; limit 1;`)
  const id = g?.artworks?.[0]?.image_id ?? g?.screenshots?.[0]?.image_id
  return id ? fetchImage(igdbUrl(id, size)) : null
}

const libretroSource = (game: CatalogGame, kind: 'Named_Boxarts' | 'Named_Snaps' | 'Named_Titles'): ImageSource => async () => {
  const def = consoleById(game.console)
  return def && def.dat !== 'igdb' ? fetchImage(thumbnailUrl(def, game.title, kind)) : null
}

/**
 * Ordre de préférence : illustrations horizontales d'abord (SteamGridDB, IGDB, écran-titre/capture Libretro),
 * jaquette verticale Libretro en dernier recours.
 */
export function imageSources(db: DatabaseSync, game: CatalogGame, kind: ImageKind, s: Settings): ImageSource[] {
  // Icône : uniquement de vraies icônes carrées (SteamGridDB) ; sans icône, l'interface affiche la pastille de la console, jamais une jaquette rognée.
  if (kind === 'icon') return [sgdbSource(db, game, s, 'icons')]
  if (kind === 'hero') {
    return [sgdbSource(db, game, s, 'heroes'), igdbSource(db, game, s, 't_1080p'), sgdbSource(db, game, s, 'grids'),
      libretroSource(game, 'Named_Titles'), libretroSource(game, 'Named_Snaps'), libretroSource(game, 'Named_Boxarts')]
  }
  const first = game.img ? [igdbSource(db, game, s, 't_screenshot_big')] : []
  return [...first, sgdbSource(db, game, s, 'grids'), libretroSource(game, 'Named_Titles'), libretroSource(game, 'Named_Snaps'),
    igdbSource(db, game, s, 't_screenshot_big'), libretroSource(game, 'Named_Boxarts')]
}

export const getImage = (db: DatabaseSync, cacheDir: string, game: CatalogGame, kind: ImageKind, s: Settings): Promise<Img | null> =>
  limited(() => cachedImage(join(cacheDir, 'images', kind), String(game.id), imageSources(db, game, kind, s)))
