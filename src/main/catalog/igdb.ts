import type { GameDetails } from '@shared/catalog'
import type { MetadataProvider } from './providers'

/** Retire régions, révisions et tags du nom No-Intro : « Zelda (USA) (Rev 1) » → « Zelda ». */
export const searchTerm = (title: string): string => title.replace(/\s*[([].*$/, '').replace(/, (The|A|An)$/, '').trim()

interface Token { value: string; expires: number }
let token: (Token & { clientId: string }) | null = null

async function accessToken(id: string, secret: string): Promise<string> {
  if (token && token.clientId === id && token.expires > Date.now() + 60_000) return token.value
  const url = `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Twitch OAuth HTTP ${res.status}`)
  const j = await res.json() as { access_token: string; expires_in: number }
  token = { clientId: id, value: j.access_token, expires: Date.now() + j.expires_in * 1000 }
  return j.access_token
}

interface IgdbGame {
  summary?: string; first_release_date?: number
  genres?: { name: string }[]
  involved_companies?: { developer: boolean; publisher: boolean; company: { name: string } }[]
}

/** IGDB (clé Twitch de l'utilisateur). Non vérifié sans identifiants réels : à valider dès qu'une clé est saisie. */
export const igdb: MetadataProvider = {
  id: 'igdb',
  dailyLimit: 2000,
  isConfigured: (s) => s.igdbClientId !== '' && s.igdbClientSecret !== '',
  async fetchDetails(game, s): Promise<GameDetails | null> {
    const term = searchTerm(game.title).replace(/["\\]/g, ' ')
    if (!term) return null
    const bearer = await accessToken(s.igdbClientId, s.igdbClientSecret)
    const res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: { 'Client-ID': s.igdbClientId, Authorization: `Bearer ${bearer}` },
      body: `search "${term}"; fields summary,first_release_date,genres.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name; limit 1;`,
      signal: AbortSignal.timeout(20_000)
    })
    if (!res.ok) throw new Error(`IGDB HTTP ${res.status}`)
    const [g] = await res.json() as IgdbGame[]
    if (!g) return null
    const company = (role: 'developer' | 'publisher'): string | undefined => g.involved_companies?.find((c) => c[role])?.company.name
    return {
      provider: 'igdb', summary: g.summary, developer: company('developer'), publisher: company('publisher'),
      releaseYear: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : undefined,
      genres: g.genres?.map((x) => x.name)
    }
  }
}
