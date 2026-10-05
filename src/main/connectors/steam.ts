import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'
import { parseVdf, vdfObject, vdfString } from './vdf'

/*
 * Steam : lit seulement `steamapps/libraryfolders.vdf` (dossiers de bibliothèque) et les `appmanifest_*.acf` (jeu installé : appid, nom, dossier). Rien d'autre
 * dans Steam n'est ouvert. Lancement par `steam://rungameid/<appid>` : Steam démarre le jeu, sans autre action de l'utilisateur.
 */

export interface SteamDeps {
  /** Dossier d'installation de Steam (registre, sinon emplacements habituels) ; null si Steam est absent. */
  steamDir(): Promise<string | null>
  readText(path: string): Promise<string | null>
  listDir(path: string): Promise<string[]>
  exists(path: string): boolean
}

/** Ce qui est installé avec Steam sans être un jeu : bibliothèques d'exécution, redistribuables, outils de compatibilité. */
const NOT_GAMES = /^(Steamworks Common Redistributables|Steam Linux Runtime|Proton\b|Steam Controller Configs|Steam Client)/i
const NOT_GAME_IDS = new Set(['228980'])

const regQuery = (): Promise<string | null> => new Promise((resolve) => {
  execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 5000 }, (err, out) => {
    const m = err ? null : /SteamPath\s+REG_SZ\s+(.+)/i.exec(out)
    resolve(m ? m[1].trim() : null)
  })
})

export const realSteamDeps: SteamDeps = {
  steamDir: async () => {
    const candidates = [await regQuery(), 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']
    return candidates.find((p): p is string => !!p && existsSync(join(p, 'steamapps'))) ?? null
  },
  readText: (p) => readFile(p, 'utf-8').catch(() => null),
  listDir: (p) => readdir(p).catch(() => []),
  exists: existsSync
}

/** Dossiers `steamapps` de toutes les bibliothèques Steam (celle de Steam, plus les disques supplémentaires déclarés dans libraryfolders.vdf). */
async function libraryDirs(deps: SteamDeps, steam: string): Promise<string[]> {
  const dirs = [join(steam, 'steamapps')]
  const text = await deps.readText(join(steam, 'steamapps', 'libraryfolders.vdf'))
  if (text) {
    const root = vdfObject(parseVdf(text).libraryfolders) ?? {}
    for (const entry of Object.values(root)) {
      const path = vdfString(vdfObject(entry)?.path)
      if (path) dirs.push(join(path, 'steamapps'))
    }
  }
  const seen = new Set<string>()
  return dirs.filter((d) => { const k = d.toLowerCase().replace(/[\\/]+$/, ''); if (seen.has(k)) return false; seen.add(k); return true })
}

/** Jeu décrit par un manifeste `appmanifest_<appid>.acf` ; null si ce n'est pas un jeu installé. */
export function gameFromManifest(text: string, steamapps: string): DetectedGame | null {
  const state = vdfObject(parseVdf(text).AppState)
  if (!state) return null
  const appid = vdfString(state.appid)
  const name = vdfString(state.name)
  const installdir = vdfString(state.installdir)
  const flags = Number(vdfString(state.StateFlags) ?? 0)
  if (!appid || !/^\d+$/.test(appid) || !name || NOT_GAME_IDS.has(appid) || NOT_GAMES.test(name)) return null
  // StateFlags : bit 4 = entièrement installé (les jeux en cours de téléchargement ou de mise à jour initiale ne sont pas encore lançables).
  if (!(flags & 4)) return null
  return { nativeId: appid, title: name, uri: `steam://rungameid/${appid}`, ...(installdir ? { installDir: join(steamapps, 'common', installdir) } : {}) }
}

export function steamConnector(deps: SteamDeps = realSteamDeps): Connector {
  return {
    id: 'steam',
    name: 'Steam',
    detect: async () => (await deps.steamDir()) !== null,
    scan: async () => {
      const steam = await deps.steamDir()
      if (!steam) return []
      const games: DetectedGame[] = []
      for (const dir of await libraryDirs(deps, steam)) {
        for (const file of await deps.listDir(dir)) {
          if (!/^appmanifest_\d+\.acf$/i.test(file)) continue
          const text = await deps.readText(join(dir, file))
          const game = text ? gameFromManifest(text, dir) : null
          if (game) games.push(game)
        }
      }
      return games
    }
  }
}
