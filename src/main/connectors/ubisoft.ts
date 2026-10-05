import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'

/*
 * Ubisoft Connect : lit seulement les clés d'installation du registre (`HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<identifiant>` : dossier d'installation).
 * Le registre ne donne pas le nom du jeu : il est déduit du nom du dossier. Lancement par `uplay://launch/<identifiant>/0`, Ubisoft Connect démarre le jeu.
 */

export interface UbisoftDeps {
  /** Pour chaque jeu installé : identifiant (nom de la sous-clé) et dossier ; null si Ubisoft Connect n'a laissé aucune clé. */
  installs(): Promise<{ id: string; dir: string }[] | null>
  exists(path: string): boolean
}

const KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs'

export function parseUbisoftRegistry(out: string): { id: string; dir: string }[] {
  const installs: { id: string; dir: string }[] = []
  let id: string | null = null
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim()
    const key = /\\Installs\\(\d+)$/i.exec(t)
    if (key) { id = key[1]; continue }
    if (/^HKEY_/i.test(t)) { id = null; continue }
    const v = id ? /^InstallDir\s+REG_SZ\s+(.+)$/i.exec(t) : null
    if (v && id) installs.push({ id, dir: v[1].trim() })
  }
  return installs
}

export const realUbisoftDeps: UbisoftDeps = {
  installs: () => new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/s'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? null : parseUbisoftRegistry(out)))
  }),
  exists: existsSync
}

export function ubisoftConnector(deps: UbisoftDeps = realUbisoftDeps): Connector {
  return {
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    detect: async () => ((await deps.installs()) ?? []).length > 0,
    scan: async () => {
      const games: DetectedGame[] = []
      for (const i of (await deps.installs()) ?? []) {
        const dir = i.dir.replace(/\//g, '\\').replace(/\\+$/, '')
        if (!dir || !deps.exists(dir)) continue
        games.push({ nativeId: i.id, title: basename(dir), installDir: dir, uri: `uplay://launch/${i.id}/0` })
      }
      return games
    }
  }
}
