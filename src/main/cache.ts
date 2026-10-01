import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppPaths } from '@shared/ipc'
import type { ClearCacheResult } from '@shared/cache'

async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  let total = 0
  for (const e of entries) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? await dirSize(p) : ((await stat(p).catch(() => null))?.size ?? 0)
  }
  return total
}

/** Taille du cache que « Vider le cache » peut libérer (mêmes dossiers que `clearCache`, hors `cache/images`). */
export async function cacheSize(paths: AppPaths): Promise<number> {
  const [downloads, emulatorCache, tools] = await Promise.all([
    dirSize(join(paths.cache, 'game-downloads')),
    dirSize(join(paths.cache, 'downloads')),
    dirSize(join(paths.cache, 'tools'))
  ])
  return downloads + emulatorCache + tools
}

export interface ClearCacheOptions {
  /** `sourceId` des téléchargements actuellement en cours : leur dossier est laissé de côté. */
  busySourceIds?: ReadonlySet<number>
  /** Une installation d'émulateur est en cours : `cache/downloads` (ses archives) est laissé de côté. */
  emulatorInstalling?: boolean
  /** Une partie tourne : `cache/tools` (scripts + ROM extraite en cours de lecture) est laissé de côté. */
  gameRunning?: boolean
}

/**
 * Vide le cache réutilisable sans toucher à `cache/images` (fiches/images du catalogue : coûteuses à regénérer
 * sous quota API IGDB/SteamGridDB/MyMemory, donc jamais vidées par cette action). Ce qui est vidé : les
 * téléchargements de jeux en attente ou en échec (`cache/game-downloads`, jamais nécessaires à une reprise — une
 * reprise HTTP Range se fait sur le `.part` encore présent pendant le téléchargement, pas sur un fichier déjà
 * terminé), les archives d'installation d'émulateurs (`cache/downloads`) et les scripts PowerShell temporaires +
 * la ROM extraite pour la partie en cours (`cache/tools`, régénérés à la prochaine utilisation).
 */
export async function clearCache(paths: AppPaths, opts: ClearCacheOptions = {}): Promise<ClearCacheResult> {
  let freedBytes = 0
  const skippedSourceIds: number[] = []

  const gameDownloads = join(paths.cache, 'game-downloads')
  for (const e of await readdir(gameDownloads, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue
    const sourceId = Number(e.name)
    if (opts.busySourceIds?.has(sourceId)) { skippedSourceIds.push(sourceId); continue }
    const p = join(gameDownloads, e.name)
    freedBytes += await dirSize(p)
    await rm(p, { recursive: true, force: true })
  }

  if (!opts.emulatorInstalling) {
    const emulatorCache = join(paths.cache, 'downloads')
    freedBytes += await dirSize(emulatorCache)
    await rm(emulatorCache, { recursive: true, force: true })
  }

  const skippedTools = !!opts.gameRunning
  if (!skippedTools) {
    const tools = join(paths.cache, 'tools')
    freedBytes += await dirSize(tools)
    await rm(tools, { recursive: true, force: true })
  }

  return { freedBytes, skippedTools, skippedSourceIds }
}
