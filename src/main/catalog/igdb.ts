import type { GameDetails } from '@shared/catalog'
import type { Settings } from '@shared/settings'
import type { MetadataProvider } from './providers'

/** Retire régions, révisions et tags du nom No-Intro : « Zelda (USA) (Rev 1) » → « Zelda ». */
export const searchTerm = (title: string): string => title.replace(/\s*[([].*$/, '').replace(/, (The|A|An)$/, '').trim()

let token: { clientId: string; value: string; expires: number } | null = null

/** Jeton d'application Twitch (client credentials), mis en cache jusqu'à expiration. */
export async function igdbToken(s: Settings): Promise<string> {
  if (token && token.clientId === s.igdbClientId && token.expires > Date.now() + 60_000) return token.value
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(s.igdbClientId)}&client_secret=${encodeURIComponent(s.igdbClientSecret)}&grant_type=client_credentials`
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Twitch OAuth HTTP ${res.status}`)
  const j = await res.json() as { access_token: string; expires_in: number }
  token = { clientId: s.igdbClientId, value: j.access_token, expires: Date.now() + j.expires_in * 1000 }
  return j.access_token
}

let lastCall = 0
/** Requête Apicalypse sur /games. IGDB limite à 4 requêtes/s : on espace les appels de 300 ms. */
export async function igdbQuery<T>(s: Settings, bearer: string, body: string): Promise<T[]> {
  const wait = lastCall + 300 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()
  const res = await fetch('https://api.igdb.com/v4/games', {
    method: 'POST', headers: { 'Client-ID': s.igdbClientId, Authorization: `Bearer ${bearer}` }, body, signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) throw new Error(`IGDB HTTP ${res.status}`)
  return await res.json() as T[]
}

interface IgdbGame {
  summary?: string; first_release_date?: number
  genres?: { name: string }[]
  involved_companies?: { developer: boolean; publisher: boolean; company: { name: string } }[]
}

export const igdb: MetadataProvider = {
  id: 'igdb',
  dailyLimit: 2000,
  isConfigured: (s) => s.igdbClientId !== '' && s.igdbClientSecret !== '',
  async fetchDetails(game, s): Promise<Partial<GameDetails> | null> {
    const term = searchTerm(game.title).replace(/["\\]/g, ' ')
    if (!term) return null
    const [g] = await igdbQuery<IgdbGame>(s, await igdbToken(s),
      `search "${term}"; fields summary,first_release_date,genres.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name; limit 1;`)
    if (!g) return null
    const company = (role: 'developer' | 'publisher'): string | undefined => g.involved_companies?.find((c) => c[role])?.company.name
    return {
      provider: 'igdb', summary: g.summary, developer: company('developer'), publisher: company('publisher'),
      releaseYear: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : undefined,
      genres: g.genres?.map((x) => x.name)
    }
  }
}
