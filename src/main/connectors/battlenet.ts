import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'

/*
 * Battle.net : lit seulement les entrées de désinstallation du registre dont l'éditeur est Blizzard (nom affiché, dossier, icône = exécutable du jeu, identifiant
 * de produit). Lancement par `battlenet://<code>` quand le code du produit est connu, sinon par l'exécutable.
 */

export type UninstallEntry = Record<string, string>

export interface BattleNetDeps {
  /** Entrées de désinstallation (valeurs de chaque clé) ; null si le registre est illisible. */
  entries(): Promise<UninstallEntry[] | null>
  exists(path: string): boolean
}

const KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'

export function parseUninstall(out: string): UninstallEntry[] {
  const list: UninstallEntry[] = []
  let cur: UninstallEntry | null = null
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) { cur = {}; list.push(cur); continue }
    const v = cur ? /^\s+(\S+)\s+REG_\w+\s*(.*)$/.exec(line) : null
    if (v && cur) cur[v[1]] = v[2].trim()
  }
  return list
}

export const realBattleNetDeps: BattleNetDeps = {
  entries: () => new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/s'], { windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? null : parseUninstall(out)))
  }),
  exists: existsSync
}

/** Codes `battlenet://` des produits Blizzard courants, selon l'identifiant `--uid=` de leur désinstallateur. */
export const PRODUCT_CODES: Record<string, string> = { wow: 'WoW', wow_classic: 'WoW', prometheus: 'Pro', s1: 'S1', s2: 'S2', d3: 'D3', hs_beta: 'WTCG', heroes: 'Hero', fenris: 'Fen', w3: 'W3', viper: 'VIPR', lazarus: 'LAZR', zeus: 'ZEUS' }

export function gameFromUninstall(e: UninstallEntry, exists: (p: string) => boolean): DetectedGame | null {
  if (!/blizzard entertainment/i.test(e.Publisher ?? '')) return null
  const title = e.DisplayName
  if (!title || /^battle\.net$/i.test(title)) return null
  const uid = /--uid=([A-Za-z0-9_]+)/.exec(e.UninstallString ?? '')?.[1]
  const dir = (e.InstallLocation ?? '').replace(/[\\/]+$/, '')
  const icon = (e.DisplayIcon ?? '').replace(/^"|"$/g, '').replace(/,\d+$/, '')
  const exe = /\.exe$/i.test(icon) && exists(icon) ? icon : undefined
  const code = uid ? PRODUCT_CODES[uid.toLowerCase()] : undefined
  if (!dir && !exe) return null
  if (dir && !exists(dir)) return null
  const game: DetectedGame = { nativeId: uid ?? title, title }
  if (dir) game.installDir = dir
  if (exe) game.exe = exe
  if (code) game.uri = `battlenet://${code}`
  return game.exe || game.uri ? game : null
}

export function battleNetConnector(deps: BattleNetDeps = realBattleNetDeps): Connector {
  const games = async (): Promise<DetectedGame[] | null> => {
    const entries = await deps.entries()
    return entries ? entries.map((e) => gameFromUninstall(e, deps.exists)).filter((g): g is DetectedGame => g !== null) : null
  }
  return {
    id: 'battlenet',
    name: 'Battle.net',
    detect: async () => ((await games()) ?? []).length > 0,
    scan: async () => (await games()) ?? []
  }
}
