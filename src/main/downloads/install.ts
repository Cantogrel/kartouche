import type { DatabaseSync } from 'node:sqlite'
import type { AppPaths } from '@shared/ipc'
import { identify } from '../library/identify'
import { importPaths, prepare } from '../library/importer'

export interface InstallResult {
  ok: boolean
  error?: string
}

/**
 * Vérifie qu'un fichier téléchargé pour `sourceId` correspond, par hash, au jeu attendu du catalogue avant de
 * l'installer — jamais d'installation silencieuse sur un hash qui ne correspond pas (P05-S1). Réutilise le pipeline
 * d'import existant (Phase 4, `importPaths`) pour la copie et l'enregistrement en bibliothèque une fois confirmé.
 */
export async function installDownload(db: DatabaseSync, sourceId: number, file: string, paths: AppPaths): Promise<InstallResult> {
  const source = db.prepare('SELECT game_id FROM sources WHERE id = ?').get(sourceId) as { game_id: number | null } | undefined
  if (!source) return { ok: false, error: 'source introuvable' }
  if (source.game_id === null) return { ok: false, error: 'aucun jeu du catalogue associé à cette source' }

  const prep = await prepare(file, [])
  if (typeof prep === 'string') return { ok: false, error: prep }

  const identified = identify(db, prep)
  if (identified.match !== 'hash' || identified.gameId !== source.game_id) {
    return { ok: false, error: 'le fichier téléchargé ne correspond pas au jeu attendu (hash différent du catalogue)' }
  }

  const result = await importPaths(db, [file], { copy: true, deleteSource: true, romsDir: paths.roms })
  const item = result.items[0]
  if (!item || item.status === 'error') return { ok: false, error: item?.error ?? "échec de l'installation" }
  return { ok: true }
}
