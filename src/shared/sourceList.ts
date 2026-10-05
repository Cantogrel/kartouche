/**
 * Format d'une liste de sources de téléchargement ajoutée par l'utilisateur (v0.2.0).
 * Kartouche ne fournit, ne scrape ni n'agrège aucune liste : chacune est une URL JSON que
 * l'utilisateur ajoute lui-même dans Paramètres → Sources, sous sa propre responsabilité.
 */
export const SOURCE_LIST_SCHEMA_VERSION = 1

export interface SourceListEntryHash {
  crc32?: string
  sha1?: string
}

export interface SourceListEntry {
  title: string
  /** Identifiant de console Kartouche (src/shared/consoles.ts), pas un identifiant Steam/IGDB. */
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
  /** Liste ajoutée depuis un fichier (et non une URL) : Kartouche en garde une copie dans son dossier de données. */
  hasLocalCopy: boolean
  /** Chemin de la copie locale (quand elle existe) : c'est ce fichier, et non l'original, que l'actualisation lit. */
  localCopyPath: string | null
}

/** Bilan de « Actualiser tout » : une liste en échec n'empêche pas les suivantes. */
export interface SourceListRefreshAllResult {
  refreshed: number
  failed: { name: string; error: string }[]
}

/** Une source de téléchargement rapprochée d'un jeu précis du catalogue (fiche jeu). */
export interface GameSource {
  id: number
  listName: string
  /** Titre tel que donné par la liste pour cette entrée précise : seul moyen de distinguer 2 entrées d'une même liste (région, langues, révision…). */
  title: string
  sizeBytes: number | null
  note: string | null
  uris: string[]
}
