import type { DatabaseSync } from 'node:sqlite'
import type { CatalogGame, GameDetails, ProviderStatus } from '@shared/catalog'
import type { Settings } from '@shared/settings'

/** Fournisseur de fiches enrichies. Renvoie null s'il ne connaît pas le jeu ; lève une erreur en cas d'échec réseau/quota. */
export interface MetadataProvider {
  id: string
  /** Plafond d'appels par jour (quota du service, avec marge). */
  dailyLimit: number
  isConfigured(settings: Settings): boolean
  fetchDetails(game: CatalogGame, settings: Settings): Promise<Partial<GameDetails> | null>
}

const DAY = (now: number): string => new Date(now).toISOString().slice(0, 10)
export const CACHE_TTL_MS = 30 * 24 * 3600 * 1000
const MISS_TTL_MS = 24 * 3600 * 1000

export function usedToday(db: DatabaseSync, provider: string, now = Date.now()): number {
  const r = db.prepare('SELECT count FROM provider_usage WHERE provider = ? AND day = ?').get(provider, DAY(now)) as { count: number } | undefined
  return r?.count ?? 0
}

export function recordUse(db: DatabaseSync, provider: string, now: number): void {
  db.prepare(`INSERT INTO provider_usage (provider, day, count) VALUES (?, ?, 1)
    ON CONFLICT(provider, day) DO UPDATE SET count = count + 1`).run(provider, DAY(now))
}

export function providerStatus(db: DatabaseSync, providers: MetadataProvider[], settings: Settings, now = Date.now()): ProviderStatus[] {
  return providers.map((p) => ({ id: p.id, configured: p.isConfigured(settings), usedToday: usedToday(db, p.id, now), dailyLimit: p.dailyLimit }))
}

const FIELDS = ['summary', 'publisher', 'developer', 'releaseYear', 'genres', 'heroUrl'] as const

/**
 * Cascade : chaque fournisseur configuré, dans l'ordre, complète la fiche (le premier qui renseigne un champ l'emporte).
 * Par fournisseur : cache local 30 j (un « inconnu » est retenu 24 h), sinon appel si le quota du jour le permet.
 * Un fournisseur en erreur ou à court de quota est simplement sauté.
 */
export async function getDetails(db: DatabaseSync, game: CatalogGame, providers: MetadataProvider[], settings: Settings,
  opts: { refresh?: boolean; now?: number } = {}): Promise<GameDetails | null> {
  const now = opts.now ?? Date.now()
  const merged: Record<string, unknown> = {}
  const sources: string[] = []
  const select = db.prepare('SELECT json, fetched_at FROM game_meta WHERE game_id = ? AND provider = ?')
  const store = db.prepare(`INSERT INTO game_meta (game_id, provider, json, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(game_id, provider) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
  // Tous les fournisseurs sont interrogés en même temps (la fiche attend le plus lent, pas la somme) ; la fusion respecte l'ordre de la cascade.
  const results = await Promise.all(providers.map(async (p): Promise<Partial<GameDetails> | null> => {
    if (!p.isConfigured(settings)) return null
    const hit = opts.refresh ? undefined : select.get(game.id, p.id) as { json: string; fetched_at: number } | undefined
    if (hit) {
      const cached = JSON.parse(hit.json) as Partial<GameDetails> | null
      if (now - hit.fetched_at < (cached ? CACHE_TTL_MS : MISS_TTL_MS)) return cached
    }
    if (usedToday(db, p.id, now) >= p.dailyLimit) return null
    recordUse(db, p.id, now)
    let d: Partial<GameDetails> | null
    try { d = await p.fetchDetails(game, settings) } catch { return null }
    store.run(game.id, p.id, JSON.stringify(d), now)
    return d
  }))
  providers.forEach((p, i) => {
    const d = results[i]
    if (!d) return
    let used = false
    for (const f of FIELDS) {
      const v = d[f]
      if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0) && merged[f] === undefined) { merged[f] = v; used = true }
    }
    if (used) sources.push(p.id)
  })
  return sources.length ? { ...merged, provider: sources.join('+') } : null
}
