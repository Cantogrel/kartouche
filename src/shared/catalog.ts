export type CatalogSort = 'popularity' | 'title' | 'year' | 'random'

/** Valeur spéciale de `CatalogQuery.sources`/`CatalogPage.sources` : jeux ayant au moins une source de téléchargement (toutes listes confondues), plutôt qu'une liste précise. */
export const SOURCE_FILTER_ANY = 'any'

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
  /** Noms des listes de sources (Paramètres → Sources) ayant une entrée reconnue pour ce jeu ; absent sur `catalog:get`. */
  sourceLists?: string[]
}

export interface CatalogQuery {
  q?: string
  consoles?: string[]
  genres?: string[]
  /** Identifiants `PublisherDef.id` (shared/publishers.ts) ; `'other'` pour le reste. */
  publishers?: string[]
  /** Identifiants `source_lists.id` (en texte) ; `SOURCE_FILTER_ANY` pour « au moins une source, toutes listes confondues ». */
  sources?: string[]
  sort?: CatalogSort
  offset?: number
  /** Sens du tri ; par défaut : décroissant pour la popularité et l'année, croissant pour le titre. */
  dir?: 'asc' | 'desc'
  /** Graine du tri `random` : même graine = même ordre (la pagination reste cohérente) ; une nouvelle graine relance le tirage. */
  seed?: number
  limit?: number
  /** Inclure bêtas, prototypes, démos, pirates et les autres versions/régions d'un même jeu (masqués par défaut). */
  includeVariants?: boolean
}

export interface CatalogPage {
  total: number
  games: CatalogGame[]
  consoles: { id: string; count: number }[]
  genres: { name: string; count: number }[]
  /** Un par `PublisherDef` (+ `'other'`), seulement ceux qui ont au moins un résultat. */
  publishers: { id: string; count: number }[]
  /** Listes de sources ayant au moins un résultat, plus `SOURCE_FILTER_ANY` en tête si au moins un jeu a une source (toutes listes confondues). */
  sources: { id: string; name: string; count: number }[]
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
  /** URL distante d'une bannière (SteamGridDB) ; l'affichage passe par le cache local kimg://hero/<id>. */
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
