/**
 * Format d'une liste de sources de téléchargement ajoutée par l'utilisateur (v0.2.0).
 * RomVault ne fournit, ne scrape ni n'agrège aucune liste : chacune est une URL JSON que
 * l'utilisateur ajoute lui-même dans Paramètres → Sources, sous sa propre responsabilité.
 */
export const SOURCE_LIST_SCHEMA_VERSION = 1

export interface SourceListEntryHash {
  crc32?: string
  sha1?: string
}

export interface SourceListEntry {
  title: string
  /** Identifiant de console RomVault (src/shared/consoles.ts), pas un identifiant Steam/IGDB. */
  console: string
  sizeBytes?: number
  /**
   * Pré-filtre optionnel avant de lancer un gros téléchargement. L'intégrité réelle est vérifiée
   * après coup contre le hash déjà connu du catalogue (catalog_games), pas contre celui-ci.
   */
  hash?: SourceListEntryHash
  uris: string[]
  note?: string
}

export interface SourceListDocument {
  schemaVersion: number
  name: string
  homepage?: string
  generatedAt?: string
  entries: SourceListEntry[]
}

export interface SourceListImportResult {
  listId: number
  name: string
  entryCount: number
  matchedCount: number
}

export interface SourceListRefreshResult {
  ok: boolean
  entryCount?: number
  matchedCount?: number
  error?: string
}

export interface SourceListSummary {
  id: number
  name: string
  url: string
  homepage: string | null
  addedAt: number
  lastRefreshedAt: number | null
  entryCount: number
  matchedCount: number
  error: string | null
}

/** Une source de téléchargement rapprochée d'un jeu précis du catalogue (fiche jeu). */
export interface GameSource {
  id: number
  listName: string
  sizeBytes: number | null
  note: string | null
  uris: string[]
}
