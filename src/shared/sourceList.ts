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
