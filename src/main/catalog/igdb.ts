import { PROXY_HEADERS, PROXY_KEY, PROXY_URL } from '@shared/proxy'
import type { GameDetails } from '@shared/catalog'
import type { Settings } from '@shared/settings'
import { consoleById } from '@shared/consoles'
import type { MetadataProvider } from './providers'
import { matchKey } from './popularity'

/** Retire régions, révisions et tags du nom No-Intro : « Zelda (USA) (Rev 1) » → « Zelda ». */
export const searchTerm = (title: string): string => title.replace(/\s*[([].*$/, '').replace(/, (The|A|An)$/, '').trim()

/** Champs communs aux requêtes IGDB qui décrivent un jeu (catalogue, enrichissement, fiche). */
export const IGDB_FIELDS = 'name,total_rating_count,genres.name,involved_companies.developer,involved_companies.publisher,involved_companies.company.name,release_dates.platform,release_dates.date'

export interface IgdbRow {
  name: string; total_rating_count?: number; summary?: string
  genres?: { name: string }[]
  involved_companies?: { developer: boolean; publisher: boolean; company: { name: string } }[]
  release_dates?: { platform: number; date?: number }[]
}

/** Année de sortie sur CETTE plateforme (first_release_date d'IGDB est la sortie la plus ancienne, souvent sur PC). */
export function platformYear(g: IgdbRow, platform: number): number | null {
  const dates = (g.release_dates ?? []).filter((d) => d.platform === platform && d.date).map((d) => d.date as number)
  return dates.length ? new Date(Math.min(...dates) * 1000).getUTCFullYear() : null
}

/** Développeur, à défaut éditeur. */
export function companyOf(g: IgdbRow): string | null {
  const c = g.involved_companies
  return (c?.find((x) => x.developer) ?? c?.find((x) => x.publisher))?.company.name ?? null
}

let token: { clientId: string; value: string; expires: number } | null = null

/** Jeton d'application Twitch (client credentials), mis en cache jusqu'à expiration. */
export async function igdbToken(s: Settings): Promise<string> {
  if (s.igdbClientId === PROXY_KEY) return PROXY_KEY // le proxy gère le jeton Twitch
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
  const viaProxy = s.igdbClientId === PROXY_KEY
  const res = await fetch(viaProxy ? `${PROXY_URL}/igdb` : 'https://api.igdb.com/v4/games', {
    method: 'POST', headers: viaProxy ? PROXY_HEADERS : { 'Client-ID': s.igdbClientId, Authorization: `Bearer ${bearer}` }, body, signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) throw new Error(`IGDB HTTP ${res.status}`)
  return await res.json() as T[]
}

export const igdb: MetadataProvider = {
  id: 'igdb',
  dailyLimit: 2000,
  isConfigured: (s) => s.igdbClientId !== '' && s.igdbClientSecret !== '',
  async fetchDetails(game, s): Promise<Partial<GameDetails> | null> {
    const term = searchTerm(game.name).replace(/["\\]/g, ' ')
    if (!term) return null
    const platform = consoleById(game.console)?.igdb
    const where = platform ? `where platforms = (${platform}); ` : ''
    const rows = await igdbQuery<IgdbRow>(s, await igdbToken(s), `search "${term}"; ${where}fields summary,${IGDB_FIELDS}; limit 10;`)
    // Le premier résultat peut être un mod ou un DLC : on préfère le jeu de même titre le plus évalué.
    const want = matchKey(term)
    const g = rows.filter((r) => matchKey(r.name) === want).sort((a, b) => (b.total_rating_count ?? 0) - (a.total_rating_count ?? 0))[0] ?? rows[0]
    if (!g) return null
    const role = (r: 'developer' | 'publisher'): string | undefined => g.involved_companies?.find((c) => c[r])?.company.name
    return {
      provider: 'igdb', summary: g.summary, developer: role('developer'), publisher: role('publisher'),
      // Année propre à la plateforme ; sans elle on laisse la main à TheGamesDB plutôt que d'afficher la sortie PC.
      releaseYear: (platform ? platformYear(g, platform) : null) ?? undefined,
      genres: g.genres?.map((x) => x.name)
    }
  }
}
