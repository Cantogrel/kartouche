import type { GameDetails } from '@shared/catalog'
import type { MetadataProvider } from './providers'
import { searchTerm } from './igdb'

/** Identifiants de plateforme TheGamesDB par console du catalogue. */
export const TGDB_PLATFORMS: Record<string, number> = {
  nes: 7, snes: 6, n64: 3, gb: 4, gbc: 41, gba: 5, nds: 8, n3ds: 4912, gc: 2, wii: 9, wiiu: 38, ps1: 10, ps2: 11, ps3: 12, psp: 13, vita: 39
}

const BASE = 'https://api.thegamesdb.net'
type Names = Record<string, { name: string }>
const lookups = new Map<string, Promise<Names>>()

/** Les genres/développeurs/éditeurs sont des identifiants : on charge chaque table une fois par session. */
function lookup(kind: 'Genres' | 'Developers' | 'Publishers', key: string): Promise<Names> {
  let p = lookups.get(kind)
  if (!p) {
    p = fetch(`${BASE}/v1/${kind}?apikey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(30_000) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`TheGamesDB HTTP ${r.status}`)
        const j = await r.json() as { data: Record<string, Names> }
        return j.data[kind.toLowerCase()] ?? {}
      })
    p.catch(() => lookups.delete(kind))
    lookups.set(kind, p)
  }
  return p
}

interface TgdbGame { game_title: string; release_date?: string; overview?: string; developers?: number[]; genres?: number[]; publishers?: number[] }

export const tgdb: MetadataProvider = {
  id: 'tgdb',
  // Le quota gratuit est mensuel (~6000) : on se limite à 150/jour.
  dailyLimit: 150,
  isConfigured: (s) => s.tgdbApiKey !== '',
  async fetchDetails(game, s): Promise<Partial<GameDetails> | null> {
    const platform = TGDB_PLATFORMS[game.console]
    const term = searchTerm(game.title)
    if (!platform || !term) return null
    const url = `${BASE}/v1.1/Games/ByGameName?apikey=${encodeURIComponent(s.tgdbApiKey)}&name=${encodeURIComponent(term)}&fields=overview,genres,publishers,developers&filter%5Bplatform%5D=${platform}`
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`TheGamesDB HTTP ${res.status}`)
    const games = ((await res.json()) as { data?: { games?: TgdbGame[] } }).data?.games ?? []
    // Le premier résultat n'est pas toujours le bon : on préfère un titre identique (insensible à la casse).
    const g = games.find((x) => x.game_title.toLowerCase() === term.toLowerCase()) ?? games[0]
    if (!g) return null
    const names = async (kind: 'Genres' | 'Developers' | 'Publishers', ids?: number[]): Promise<string[]> => {
      if (!ids?.length) return []
      const t = await lookup(kind, s.tgdbApiKey).catch(() => ({} as Names))
      return ids.map((i) => t[String(i)]?.name).filter((n): n is string => !!n)
    }
    const [genres, developers, publishers] = await Promise.all([names('Genres', g.genres), names('Developers', g.developers), names('Publishers', g.publishers)])
    const year = Number.parseInt(g.release_date ?? '', 10)
    return {
      provider: 'tgdb', summary: g.overview?.replace(/\r\n/g, '\n').trim() || undefined, genres,
      developer: developers[0], publisher: publishers[0], releaseYear: Number.isFinite(year) ? year : undefined
    }
  }
}
