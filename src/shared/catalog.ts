export type CatalogSort = 'popularity' | 'title' | 'year'

export interface CatalogGame {
  id: number
  console: string
  title: string
  /** Titre lisible (sans région ni révision) : c'est celui qu'on affiche, cherche et trie. */
  name: string
  region: string
  year: number | null
  genre: string | null
  developer: string | null
  crc: string | null
  sha1: string | null
  size: number | null
  /** Score de popularité (IGDB) ; null tant que non calculé. */
  popularity: number | null
  /** Identifiant d'image IGDB, si le catalogue en fournit (Switch). */
  img: string | null
}

export interface CatalogQuery {
  q?: string
  consoles?: string[]
  genres?: string[]
  sort?: CatalogSort
  offset?: number
  /** Sens du tri ; par défaut : décroissant pour la popularité et l'année, croissant pour le titre. */
  dir?: 'asc' | 'desc'
  limit?: number
  /** Inclure bêtas, prototypes, démos, pirates et les autres versions/régions d'un même jeu (masqués par défaut). */
  includeVariants?: boolean
}

export interface CatalogPage {
  total: number
  games: CatalogGame[]
  consoles: { id: string; count: number }[]
  genres: { name: string; count: number }[]
}

export interface SyncProgress {
  console: string
  done: number
  total: number
  error?: string
}

export interface SyncResult {
  synced: number
  failed: string[]
}

/** Fiche enrichie par un fournisseur externe (IGDB…), mise en cache localement. */
export interface GameDetails {
  provider: string
  summary?: string
  publisher?: string
  developer?: string
  releaseYear?: number
  genres?: string[]
  /** Langue et origine de `summary` (traduit, Wikipédia…) ; absent = texte source en anglais. */
  summaryLang?: string
  summarySource?: 'wikipedia' | 'machine'
  /** URL distante d'une bannière (SteamGridDB) ; l'affichage passe par le cache local rvimg://hero/<id>. */
  heroUrl?: string
}

export interface ProviderStatus {
  id: string
  configured: boolean
  usedToday: number
  dailyLimit: number
}

/**
 * Titre lisible d'un nom No-Intro/Redump : sans région, langues ni révision, article remis devant.
 * « Legend of Zelda, The - A Link to the Past (USA) (Rev 1) » → « The Legend of Zelda - A Link to the Past ».
 */
export function displayTitle(raw: string): string {
  const s = raw.replace(/\s*[(\[][^)\]]*[)\]]/g, '').trim()
  return s.replace(/^(.*?), (The|A|An)(?= - |: |$)/, '$2 $1').trim() || raw
}
