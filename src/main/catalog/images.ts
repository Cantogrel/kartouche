import { PROXY_HEADERS, PROXY_KEY, PROXY_URL } from '@shared/proxy'
import type { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleById } from '@shared/consoles'
import type { CatalogGame } from '@shared/catalog'
import type { Settings } from '@shared/settings'
import { thumbnailUrl } from './libretro'
import { igdbQuery, igdbToken, searchTerm } from './igdb'
import { recordUse, usedToday } from './providers'

/**
 * `card` : vignette horizontale de la liste du catalogue (200x112, `.thumb`) ; `tile` : tuile verticale (ratio 2/3)
 * de la Bibliothèque/Accueil/Big Picture ; `hero` : grande bannière de la fiche ; `icon` : icône carrée (menu latéral).
 */
export type ImageKind = 'card' | 'tile' | 'hero' | 'icon'
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

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function fetchImage(url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<Buffer | null> {
  const res = await fetch(url, { headers, signal: withTimeout(signal, 30_000) })
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

/**
 * Appels réseau limités à `MAX_PARALLEL` en parallèle : une page de catalogue déclenche des dizaines de résolutions d'images.
 * Les tâches en attente sont servies dernière arrivée d'abord : en faisant défiler, ce sont les tuiles à l'écran maintenant (les plus récemment
 * demandées) qui passent avant celles déjà dépassées, au lieu d'attendre derrière tout ce qui a été demandé plus haut.
 * `signal` (celui de la requête `rvimg://`) permet d'abandonner tôt une tâche dont la tuile a déjà disparu (filtres
 * changés très vite) : en attente, elle ne consomme jamais un des 4 emplacements ; déjà lancée, `fetchImage` coupe
 * la requête réseau en cours au lieu de tourner jusqu'à son terme (jusqu'à 30 s) et de retarder les suivantes.
 */
export const MAX_PARALLEL = 8
const queue: { resolve: () => void }[] = []
let running = 0
export async function limited<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (running >= MAX_PARALLEL) {
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve: () => { signal?.removeEventListener('abort', onAbort); resolve() } }
      const onAbort = (): void => {
        const i = queue.indexOf(waiter)
        if (i >= 0) queue.splice(i, 1)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      queue.push(waiter)
    })
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  running++
  try { return await fn() } finally { running--; queue.pop()?.resolve() }
}

async function sgdbApi<T>(db: DatabaseSync, path: string, key: string, signal?: AbortSignal): Promise<T | null> {
  if (usedToday(db, 'sgdb-img') >= IMG_LIMIT) return null
  recordUse(db, 'sgdb-img', Date.now())
  const res = await fetch(`${key === PROXY_KEY ? `${PROXY_URL}/sgdb` : SGDB}${path}`, { headers: key === PROXY_KEY ? PROXY_HEADERS : { Authorization: `Bearer ${key}` }, signal: withTimeout(signal, 30_000) })
  if (!res.ok) return null
  return ((await res.json()) as { data: T }).data
}

/** Normalise pour comparer un nom malgré accents/ponctuation/casse (« Pokémon: Yellow » ~ « pokemon yellow »). */
const normalizeName = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Un nom « correspond » à `want` s'il est égal, ou si le plus court des deux est un début propre de l'autre (le nom
 * court de SteamGridDB, ex. « Pokémon Yellow Version », est presque toujours un simple préfixe du titre complet du
 * DAT avec son sous-titre, ex. « Pokemon - Yellow Version - Special Pikachu Edition » — les rejeter faute d'égalité
 * stricte privait d'icône une bonne partie du catalogue). `minLen` évite qu'un préfixe trivialement court (« Mario »)
 * ne matche n'importe quel jeu de la série.
 */
function looseNameMatch(want: string, name: string, minLen = 6): boolean {
  const k = normalizeName(name)
  if (k === want) return true
  const [shorter, longer] = k.length <= want.length ? [k, want] : [want, k]
  return shorter.length >= minLen && longer.startsWith(shorter)
}

/**
 * Identifiant SteamGridDB du jeu (recherche par nom), mémorisé y compris quand il n'y en a pas. Aucun résultat
 * approché n'est retenu au-delà de `looseNameMatch` : sur une franchise (Pokémon Rouge/Jaune, Final Fantasy…), le
 * premier résultat de l'autocomplete est souvent un AUTRE jeu de la même série (un titre régional ne correspond à
 * aucune entrée SGDB telle quelle) plutôt que celui recherché — mieux vaut aucune image que celle d'un autre jeu.
 */
export async function sgdbId(db: DatabaseSync, game: CatalogGame, key: string, signal?: AbortSignal): Promise<number | null> {
  const row = db.prepare("SELECT json FROM game_meta WHERE game_id = ? AND provider = 'sgdb-id'").get(game.id) as { json: string } | undefined
  if (row) return (JSON.parse(row.json) as { id: number | null }).id
  const term = searchTerm(game.name)
  const found = term ? await sgdbApi<{ id: number; name: string }[]>(db, `/search/autocomplete/${encodeURIComponent(term)}`, key, signal) : null
  if (found === null) throw new Error('SteamGridDB indisponible')
  const want = normalizeName(term)
  const hit = found.find((f) => looseNameMatch(want, f.name))
  db.prepare("INSERT OR REPLACE INTO game_meta (game_id, provider, json, fetched_at) VALUES (?, 'sgdb-id', ?, ?)").run(game.id, JSON.stringify({ id: hit?.id ?? null }), Date.now())
  return hit?.id ?? null
}

const sgdbSource = (db: DatabaseSync, game: CatalogGame, s: Settings, kind: 'grids' | 'heroes' | 'icons', dims?: string, signal?: AbortSignal): ImageSource => async () => {
  if (!s.sgdbApiKey) return null
  const id = await sgdbId(db, game, s.sgdbApiKey, signal)
  if (id === null) return null
  const q = kind === 'grids' ? `?dimensions=${dims ?? '460x215,920x430'}&limit=1` : kind === 'icons' ? '?mimes=image/png&limit=1' : '?limit=1'
  const list = await sgdbApi<{ url: string }[]>(db, `/${kind}/game/${id}${q}`, s.sgdbApiKey, signal)
  return list?.[0] ? fetchImage(list[0].url, undefined, signal) : null
}

const igdbUrl = (imageId: string, size: 't_screenshot_big' | 't_1080p'): string => `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg`

/** Illustration IGDB : celle mémorisée au moment de la synchro (Switch), sinon recherche par nom sur la plateforme du jeu. */
const igdbSource = (db: DatabaseSync, game: CatalogGame, s: Settings, size: 't_screenshot_big' | 't_1080p', signal?: AbortSignal): ImageSource => async () => {
  if (game.img) return fetchImage(igdbUrl(game.img, size), undefined, signal)
  const platform = consoleById(game.console)?.igdb
  if (!s.igdbClientId || !s.igdbClientSecret || !platform || usedToday(db, 'igdb-img') >= IMG_LIMIT) return null
  recordUse(db, 'igdb-img', Date.now())
  const term = searchTerm(game.name).replace(/["\\]/g, ' ')
  const [g] = await igdbQuery<{ artworks?: { image_id: string }[]; screenshots?: { image_id: string }[] }>(s, await igdbToken(s),
    `search "${term}"; where platforms = (${platform}); fields artworks.image_id,screenshots.image_id; limit 1;`)
  const id = g?.artworks?.[0]?.image_id ?? g?.screenshots?.[0]?.image_id
  return id ? fetchImage(igdbUrl(id, size), undefined, signal) : null
}

const libretroSource = (game: CatalogGame, kind: 'Named_Boxarts' | 'Named_Snaps' | 'Named_Titles', signal?: AbortSignal): ImageSource => async () => {
  const def = consoleById(game.console)
  return def && def.dat !== 'igdb' ? fetchImage(thumbnailUrl(def, game.title, kind), undefined, signal) : null
}

/**
 * Ordre de préférence par format de destination :
 * - `hero` (bannière large) et `card` (vignette horizontale 200x112 de la liste du catalogue, `.thumb`) : illustrations
 *   horizontales d'abord (SteamGridDB, IGDB, écran-titre/capture Libretro), jaquette verticale Libretro en dernier
 *   recours (rendue entière sur fond flouté, cf. `Cover`) — une jaquette portrait y serait de toute façon très rognée.
 * - `tile` : tuile verticale (ratio 2/3, cf. `.card`/`.bp-tile`/`.bp-detail-cover` en CSS) de la Bibliothèque, de
 *   l'Accueil et du Big Picture → la jaquette (portrait, cadre exact en capsule SteamGridDB 600x900) est privilégiée
 *   pour remplir la tuile sans recadrage agressif ; un écran-titre/capture (horizontal) y resterait fortement rogné,
 *   donc relégué en dernier recours.
 */
export function imageSources(db: DatabaseSync, game: CatalogGame, kind: ImageKind, s: Settings, signal?: AbortSignal): ImageSource[] {
  // Icône : uniquement de vraies icônes carrées (SteamGridDB) ; sans icône, l'interface affiche la pastille de la console, jamais une jaquette rognée.
  if (kind === 'icon') return [sgdbSource(db, game, s, 'icons', undefined, signal)]
  if (kind === 'hero') {
    return [sgdbSource(db, game, s, 'heroes', undefined, signal), igdbSource(db, game, s, 't_1080p', signal), sgdbSource(db, game, s, 'grids', undefined, signal),
      libretroSource(game, 'Named_Titles', signal), libretroSource(game, 'Named_Snaps', signal), libretroSource(game, 'Named_Boxarts', signal)]
  }
  const first = game.img ? [igdbSource(db, game, s, 't_screenshot_big', signal)] : []
  if (kind === 'tile') {
    return [sgdbSource(db, game, s, 'grids', '600x900', signal), libretroSource(game, 'Named_Boxarts', signal), ...first,
      libretroSource(game, 'Named_Titles', signal), libretroSource(game, 'Named_Snaps', signal), igdbSource(db, game, s, 't_screenshot_big', signal)]
  }
  return [...first, sgdbSource(db, game, s, 'grids', undefined, signal), libretroSource(game, 'Named_Titles', signal), libretroSource(game, 'Named_Snaps', signal),
    igdbSource(db, game, s, 't_screenshot_big', signal), libretroSource(game, 'Named_Boxarts', signal)]
}

/**
 * Annulation explicite : `req.signal` (Electron `protocol.handle`) NE s'arme PAS quand le rendu retire l'`<img>`
 * qui a émis la requête (vérifié : `signal.aborted` reste `false` jusqu'au bout même après la suppression du nœud) —
 * seul un rechargement/fermeture de page l'arme. Le renderer doit donc annuler lui-même (`images:cancel`, cf.
 * `Cover`/`GameIcon`) une tuile qui disparaît avant sa résolution ; c'est ce contrôleur par clé qui porte l'annulation
 * réelle jusqu'au `fetch` en cours (cf. [[bigpicture-images-abort-gotcha]] côté mémoire projet).
 */
const pending = new Map<string, AbortController>()

export function cancelImage(kind: ImageKind, gameId: number): void {
  pending.get(`${kind}:${gameId}`)?.abort()
}

export async function getImage(db: DatabaseSync, cacheDir: string, game: CatalogGame, kind: ImageKind, s: Settings, signal?: AbortSignal): Promise<Img | null> {
  const key = `${kind}:${game.id}`
  const ac = new AbortController()
  pending.set(key, ac)
  const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal
  try {
    return await limited(() => cachedImage(join(cacheDir, 'images', kind), String(game.id), imageSources(db, game, kind, s, combined)), combined)
  } finally {
    if (pending.get(key) === ac) pending.delete(key)
  }
}
