import type { DatabaseSync } from 'node:sqlite'
import type { CatalogGame, GameDetails, ProviderStatus } from '@shared/catalog'
import type { Settings } from '@shared/settings'

/** Fournisseur de fiches enrichies. Renvoie null s'il ne connaît pas le jeu ; lève une erreur en cas d'échec réseau/quota. */
export interface MetadataProvider {
  id: string
  /** Plafond d'appels par jour (quota du service, avec marge). */
  dailyLimit: number
  isConfigured(settings: Settings): boolean
  fetchDetails(game: CatalogGame, settings: Settings): Promise<GameDetails | null>
}

const DAY = (now: number): string => new Date(now).toISOString().slice(0, 10)
export const CACHE_TTL_MS = 30 * 24 * 3600 * 1000
const MISS_TTL_MS = 24 * 3600 * 1000

export function usedToday(db: DatabaseSync, provider: string, now = Date.now()): number {
  const r = db.prepare('SELECT count FROM provider_usage WHERE provider = ? AND day = ?').get(provider, DAY(now)) as { count: number } | undefined
  return r?.count ?? 0
}

function recordUse(db: DatabaseSync, provider: string, now: number): void {
  db.prepare(`INSERT INTO provider_usage (provider, day, count) VALUES (?, ?, 1)
    ON CONFLICT(provider, day) DO UPDATE SET count = count + 1`).run(provider, DAY(now))
}

export function providerStatus(db: DatabaseSync, providers: MetadataProvider[], settings: Settings, now = Date.now()): ProviderStatus[] {
  return providers.map((p) => ({ id: p.id, configured: p.isConfigured(settings), usedToday: usedToday(db, p.id, now), dailyLimit: p.dailyLimit }))
}

/**
 * Cascade : cache local d'abord (30 j ; un échec « inconnu » est retenu 24 h pour ne pas re-solliciter les quotas),
 * puis chaque fournisseur configuré et sous son quota, dans l'ordre. Un fournisseur en erreur passe la main au suivant.
 */
export async function getDetails(db: DatabaseSync, game: CatalogGame, providers: MetadataProvider[], settings: Settings,
  opts: { refresh?: boolean; now?: number } = {}): Promise<GameDetails | null> {
  const now = opts.now ?? Date.now()
  if (!opts.refresh) {
    const hit = db.prepare('SELECT provider, json, fetched_at FROM game_meta WHERE game_id = ? ORDER BY fetched_at DESC').all(game.id) as { provider: string; json: string; fetched_at: number }[]
    for (const h of hit) {
      if (h.provider === '_miss') { if (now - h.fetched_at < MISS_TTL_MS) return null; continue }
      if (now - h.fetched_at < CACHE_TTL_MS) return JSON.parse(h.json) as GameDetails
    }
  }
  let tried = false
  for (const p of providers) {
    if (!p.isConfigured(settings) || usedToday(db, p.id, now) >= p.dailyLimit) continue
    tried = true
    recordUse(db, p.id, now)
    let d: GameDetails | null = null
    try { d = await p.fetchDetails(game, settings) } catch { continue }
    if (d) {
      db.prepare(`INSERT INTO game_meta (game_id, provider, json, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(game_id, provider) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`).run(game.id, p.id, JSON.stringify(d), now)
      return d
    }
  }
  if (tried) db.prepare(`INSERT INTO game_meta (game_id, provider, json, fetched_at) VALUES (?, '_miss', '{}', ?)
    ON CONFLICT(game_id, provider) DO UPDATE SET fetched_at = excluded.fetched_at`).run(game.id, now)
  return null
}
