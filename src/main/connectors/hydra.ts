import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'
import { latestValues, readLog, readTable, type LevelEntry } from './leveldb'

/*
 * Hydra : lit seulement la liste des jeux de sa base locale (`%APPDATA%\hydralauncher\hydra-db`, table « games ») pour reprendre ceux qui sont installés,
 * c'est-à-dire qui ont un exécutable renseigné. Aucun compte, aucune source ni liste de téléchargement de Hydra n'est lu (voir DEC-0170) : Kartouche ne
 * s'en sert pas comme source. Lancement : l'exécutable.
 */

export interface HydraDeps {
  dbDir(): string | null
  listDir(path: string): Promise<string[]>
  readFile(path: string): Promise<Buffer | null>
}

export const realHydraDeps: HydraDeps = {
  dbDir: () => {
    const dir = join(process.env.APPDATA ?? '', 'hydralauncher', 'hydra-db')
    return process.env.APPDATA && existsSync(join(dir, 'CURRENT')) ? dir : null
  },
  listDir: (p) => readdir(p).catch(() => []),
  readFile: (p) => readFile(p).catch(() => null)
}

const GAMES_PREFIX = '!games!'
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Jeu décrit par la valeur JSON d'une entrée de la table « games » ; null s'il n'est pas installé (aucun exécutable), supprimé ou illisible. */
export function gameFromHydra(key: string, raw: string): DetectedGame | null {
  let v: Record<string, unknown>
  try { const j: unknown = JSON.parse(raw); if (!j || typeof j !== 'object') return null; v = j as Record<string, unknown> } catch { return null }
  const title = text(v.title)
  const exe = text(v.executablePath)
  if (!title || !exe || v.isDeleted === true) return null
  // Clé : « <boutique>:<objectId> » (steam:359310) ; sans elle, l'identifiant de la valeur.
  const nativeId = key.startsWith(GAMES_PREFIX) ? key.slice(GAMES_PREFIX.length) : (text(v.shop) && text(v.objectId) ? `${v.shop}:${v.objectId}` : undefined)
  if (!nativeId) return null
  return { nativeId, title, exe, installDir: dirname(exe), cwd: dirname(exe) }
}

export function hydraConnector(deps: HydraDeps = realHydraDeps): Connector {
  return {
    id: 'hydra',
    name: 'Hydra',
    detect: async () => deps.dbDir() !== null,
    scan: async () => {
      const dir = deps.dbDir()
      if (!dir) return []
      const parts: LevelEntry[][] = []
      for (const f of await deps.listDir(dir)) {
        if (!/\.(log|ldb)$/i.test(f)) continue
        const buf = await deps.readFile(join(dir, f))
        if (buf) parts.push(/\.log$/i.test(f) ? readLog(buf) : readTable(buf))
      }
      const games: DetectedGame[] = []
      for (const [key, value] of latestValues(parts)) {
        if (!key.startsWith(GAMES_PREFIX)) continue
        const g = gameFromHydra(key, value.toString('utf-8'))
        if (g) games.push(g)
      }
      return games
    }
  }
}
