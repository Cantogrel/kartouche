import type { GameDetails } from '@shared/catalog'
import type { MetadataProvider } from './providers'
import { searchTerm } from './igdb'

const BASE = 'https://www.steamgriddb.com/api/v2'

async function api<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`SteamGridDB HTTP ${res.status}`)
  return ((await res.json()) as { data: T }).data
}

/** SteamGridDB : bannière (« hero ») pour la fiche du jeu. Pas de texte. */
export const sgdb: MetadataProvider = {
  id: 'sgdb',
  dailyLimit: 500,
  isConfigured: (s) => s.sgdbApiKey !== '',
  async fetchDetails(game, s): Promise<Partial<GameDetails> | null> {
    const term = searchTerm(game.title)
    if (!term) return null
    const found = await api<{ id: number; name: string }[]>(`/search/autocomplete/${encodeURIComponent(term)}`, s.sgdbApiKey)
    const hit = found.find((f) => f.name.toLowerCase() === term.toLowerCase()) ?? found[0]
    if (!hit) return null
    const heroes = await api<{ url: string }[]>(`/heroes/game/${hit.id}?limit=1`, s.sgdbApiKey)
    return heroes[0] ? { provider: 'sgdb', heroUrl: heroes[0].url } : null
  }
}
