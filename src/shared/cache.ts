export interface ClearCacheResult {
  freedBytes: number
  /** `cache/tools` (scripts PowerShell + ROM extraite pour la partie en cours) laissé de côté : une partie tourne. */
  skippedTools: boolean
  /** `sourceId` des téléchargements en cours, laissés de côté. */
  skippedSourceIds: number[]
}
