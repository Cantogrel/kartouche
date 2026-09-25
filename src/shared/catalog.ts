export type CatalogSort = 'popularity' | 'title' | 'year'

export interface CatalogGame {
  id: number
  console: string
  title: string
  region: string
  year: number | null
  genre: string | null
  developer: string | null
  crc: string | null
  sha1: string | null
  size: number | null
  /** Score de popularité (IGDB) ; null tant que non calculé. */
  popularity: number | null
}

export interface CatalogQuery {
  q?: string
  consoles?: string[]
  genres?: string[]
  sort?: CatalogSort
  offset?: number
  limit?: number
  /** Inclure bêtas, prototypes, démos, pirates… (masqués par défaut). */
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
  /** URL distante d'une bannière (SteamGridDB) ; l'affichage passe par le cache local rvimg://hero/<id>. */
  heroUrl?: string
}

export interface ProviderStatus {
  id: string
  configured: boolean
  usedToday: number
  dailyLimit: number
}
