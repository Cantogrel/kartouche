import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'

/*
 * Epic Games : lit seulement les manifestes d'installation `ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item` (nom, dossier, exécutable, identifiants
 * du catalogue). Lancement par l'adresse `com.epicgames.launcher://apps/…?action=launch` : Epic démarre le jeu ; l'exécutable sert de repli.
 */

export interface EpicDeps {
  manifestsDir(): string | null
  listDir(path: string): Promise<string[]>
  readText(path: string): Promise<string | null>
}

export const realEpicDeps: EpicDeps = {
  manifestsDir: () => {
    const dir = join(process.env.ProgramData ?? 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
    return existsSync(dir) ? dir : null
  },
  listDir: (p) => readdir(p).catch(() => []),
  readText: (p) => readFile(p, 'utf-8').catch(() => null)
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Jeu décrit par un manifeste `.item` ; null pour un contenu additionnel, une installation incomplète ou un manifeste illisible. */
export function gameFromEpicManifest(raw: string): DetectedGame | null {
  let m: Record<string, unknown>
  try { const v: unknown = JSON.parse(raw); if (!v || typeof v !== 'object') return null; m = v as Record<string, unknown> } catch { return null }
  const appName = text(m.AppName)
  const title = text(m.DisplayName)
  if (!appName || !title) return null
  if (m.bIsIncompleteInstall === true) return null
  // Contenu additionnel (DLC, extensions) : son AppName diffère de celui du jeu principal ; ce qui n'est pas dans la catégorie « games » n'est pas un jeu.
  const main = text(m.MainGameAppName)
  if (main && main !== appName) return null
  const cats = Array.isArray(m.AppCategories) ? (m.AppCategories as unknown[]).filter((c): c is string => typeof c === 'string') : []
  if (cats.length > 0 && !cats.includes('games')) return null
  const dir = text(m.InstallLocation)
  const exeName = text(m.LaunchExecutable)
  const ns = text(m.CatalogNamespace)
  const item = text(m.CatalogItemId)
  const game: DetectedGame = { nativeId: appName, title }
  if (dir) game.installDir = dir.replace(/\//g, '\\')
  if (dir && exeName) { game.exe = join(dir, exeName).replace(/\//g, '\\'); game.cwd = dir.replace(/\//g, '\\') }
  const args = text(m.LaunchCommand); if (args) game.args = args
  if (ns && item) game.uri = `com.epicgames.launcher://apps/${ns}%3A${item}%3A${appName}?action=launch&silent=true`
  return game
}

export function epicConnector(deps: EpicDeps = realEpicDeps): Connector {
  return {
    id: 'epic',
    name: 'Epic Games',
    detect: async () => deps.manifestsDir() !== null,
    scan: async () => {
      const dir = deps.manifestsDir()
      if (!dir) return []
      const games: DetectedGame[] = []
      for (const f of await deps.listDir(dir)) {
        if (!/\.item$/i.test(f)) continue
        const raw = await deps.readText(join(dir, f))
        const g = raw ? gameFromEpicManifest(raw) : null
        if (g) games.push(g)
      }
      return games
    }
  }
}
