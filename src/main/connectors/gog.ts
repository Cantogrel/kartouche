import { execFile } from 'node:child_process'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'

/*
 * GOG : lit seulement les clés de jeux installés du registre (`HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>` : nom, dossier, exécutable). Les jeux GOG se lancent
 * sans GOG Galaxy : l'exécutable est lancé directement, sans autre action de l'utilisateur.
 */

export type RegistryGame = Record<string, string>

export interface GogDeps {
  /** Valeurs de chaque clé de jeu installé ; null si GOG n'a laissé aucune clé (non installé). */
  games(): Promise<RegistryGame[] | null>
}

const KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games'

/** Découpe la sortie de `reg query <clé> /s` : un bloc par clé, ses valeurs `nom  REG_SZ  donnée`. Les sous-clés de jeu seulement (pas la clé racine). */
export function parseRegGames(out: string): RegistryGame[] {
  const games: RegistryGame[] = []
  let cur: RegistryGame | null = null
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      // Une sous-clé directe de Games = un jeu ; la racine et les clés plus profondes sont ignorées.
      const rest = line.trim().replace(/^HKEY_LOCAL_MACHINE\\/i, '').toLowerCase().replace('software\\wow6432node\\gog.com\\games', '')
      cur = /^\\[^\\]+$/.test(rest) ? {} : null
      if (cur) games.push(cur)
      continue
    }
    const m = cur ? /^\s+(\S+)\s+REG_\w+\s*(.*)$/.exec(line) : null
    if (m && cur) cur[m[1]] = m[2].trim()
  }
  return games
}

export const realGogDeps: GogDeps = {
  games: () => new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/s'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? null : parseRegGames(out)))
  })
}

export function gameFromRegistry(v: RegistryGame): DetectedGame | null {
  const id = v.gameID || v.productID
  const title = v.gameName
  // Contenu additionnel (DLC) : déclare le jeu dont il dépend.
  if (!id || !title || v.dependsOn) return null
  const dir = v.path
  const exe = v.exe || (dir && v.exeFile ? `${dir.replace(/[\\/]+$/, '')}\\${v.exeFile}` : '')
  if (!exe) return null
  const game: DetectedGame = { nativeId: id, title, exe }
  if (dir) game.installDir = dir
  const cwd = v.workingDir || dir; if (cwd) game.cwd = cwd
  if (v.launchParam) game.args = v.launchParam
  return game
}

export function gogConnector(deps: GogDeps = realGogDeps): Connector {
  return {
    id: 'gog',
    name: 'GOG',
    detect: async () => ((await deps.games()) ?? []).length > 0,
    scan: async () => ((await deps.games()) ?? []).map(gameFromRegistry).filter((g): g is DetectedGame => g !== null)
  }
}
