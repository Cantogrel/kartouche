import type { DatabaseSync } from 'node:sqlite'
import type { CatalogGame } from '@shared/catalog'
import type { Settings } from '@shared/settings'
import { consoleById } from '@shared/consoles'
import { pickImages, pickTrailers, type GameMedia } from '@shared/media'
import { igdbQuery, igdbToken, searchTerm } from './igdb'
import { matchKey } from './popularity'
import { CACHE_TTL_MS, recordUse, usedToday } from './providers'

/*
 * Bandes-annonces, captures et artworks d'un jeu : même service qu'IGDB (même requête Apicalypse, via le proxy si l'utilisateur n'a pas sa propre clé),
 * mis en cache dans `game_meta` sous le fournisseur `igdb-media` (30 jours ; « inconnu » retenu 24 h) pour ne pas redemander à chaque ouverture de fiche.
 */

const PROVIDER = 'igdb-media'
const DAILY_LIMIT = 2000
const MISS_TTL_MS = 24 * 3600 * 1000

interface MediaRow {
  name: string
  total_rating_count?: number
  videos?: { video_id?: string; name?: string }[]
  screenshots?: { image_id?: string }[]
  artworks?: { image_id?: string }[]
}

/** Requête Apicalypse sur /games ; injectable pour les tests. */
export type MediaQuery = (body: string) => Promise<MediaRow[]>

export async function fetchMedia(game: CatalogGame, query: MediaQuery): Promise<GameMedia | null> {
  const term = searchTerm(game.name).replace(/["\\]/g, ' ')
  if (!term) return null
  const platform = consoleById(game.console)?.igdb
  const where = platform ? `where platforms = (${platform}); ` : ''
  const rows = await query(`search "${term}"; ${where}fields name,total_rating_count,videos.video_id,videos.name,screenshots.image_id,artworks.image_id; limit 10;`)
  // Même choix que la fiche (igdb.ts) : le jeu de même titre le plus évalué, pas un mod ni un DLC.
  const want = matchKey(term)
  const g = rows.filter((r) => matchKey(r.name) === want).sort((a, b) => (b.total_rating_count ?? 0) - (a.total_rating_count ?? 0))[0] ?? rows[0]
  if (!g) return null
  const media: GameMedia = { trailers: pickTrailers(g.videos), screenshots: pickImages(g.screenshots), artworks: pickImages(g.artworks, 6) }
  return media.trailers.length || media.screenshots.length || media.artworks.length ? media : null
}

/**
 * Médias d'un jeu, depuis le cache ou IGDB. Renvoie null quand rien n'est disponible, quand le service n'est pas configuré, quand le quota du jour est
 * atteint ou en cas d'erreur réseau (rien n'est alors mis en cache : l'ouverture suivante réessaie).
 */
export async function getMedia(db: DatabaseSync, game: CatalogGame, settings: Settings, opts: { refresh?: boolean; now?: number; query?: MediaQuery } = {}): Promise<GameMedia | null> {
  const now = opts.now ?? Date.now()
  if (!opts.query && settings.igdbClientId === '') return null
  const hit = opts.refresh ? undefined : db.prepare('SELECT json, fetched_at FROM game_meta WHERE game_id = ? AND provider = ?').get(game.id, PROVIDER) as { json: string; fetched_at: number } | undefined
  if (hit) {
    const cached = JSON.parse(hit.json) as GameMedia | null
    if (now - hit.fetched_at < (cached ? CACHE_TTL_MS : MISS_TTL_MS)) return cached
  }
  if (usedToday(db, PROVIDER, now) >= DAILY_LIMIT) return null
  recordUse(db, PROVIDER, now)
  const query = opts.query ?? (async (body: string) => igdbQuery<MediaRow>(settings, await igdbToken(settings), body))
  let media: GameMedia | null
  try { media = await fetchMedia(game, query) } catch { return null }
  db.prepare(`INSERT INTO game_meta (game_id, provider, json, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(game_id, provider) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`).run(game.id, PROVIDER, JSON.stringify(media), now)
  return media
}
