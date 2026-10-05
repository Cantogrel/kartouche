import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'

/*
 * EA app : lit seulement les clés d'installation de `HKLM\SOFTWARE\WOW6432Node\EA Games\<jeu>` (dossier d'installation) et, dans ce dossier, le
 * `__Installer\installerdata.xml` (titre, identifiant de contenu, exécutable). Lancement par `origin2://game/launch/?offerIds=<contenu>` : l'EA app démarre
 * le jeu ; l'exécutable sert de repli.
 */

export interface EaDeps {
  /** Valeurs de chaque clé de jeu ; null si l'EA app n'a laissé aucune clé. */
  registryGames(): Promise<Record<string, string>[] | null>
  readText(path: string): Promise<string | null>
  exists(path: string): boolean
  listDir(path: string): Promise<string[]>
}

const KEY = 'HKLM\\SOFTWARE\\WOW6432Node\\EA Games'

/** `reg query` découpé en une table par sous-clé directe ; le nom de la sous-clé est exposé en `__key`. */
export function parseEaRegistry(out: string): Record<string, string>[] {
  const games: Record<string, string>[] = []
  let cur: Record<string, string> | null = null
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim()
    if (/^HKEY_/i.test(t)) {
      const m = /\\EA Games\\([^\\]+)$/i.exec(t)
      cur = m ? { __key: m[1] } : null
      if (cur) games.push(cur)
      continue
    }
    const v = cur ? /^\s+(.+?)\s{2,}REG_\w+\s*(.*)$/.exec(line) : null
    if (v && cur) cur[v[1]] = v[2].trim()
  }
  return games
}

export const realEaDeps: EaDeps = {
  registryGames: () => new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/s'], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? null : parseEaRegistry(out)))
  }),
  readText: (p) => readFile(p, 'utf-8').catch(() => null),
  exists: existsSync,
  listDir: (p) => readdir(p).catch(() => [])
}

const decode = (s: string): string => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")

/** Titre, identifiant de contenu et exécutable lus dans `installerdata.xml` (tous facultatifs). */
export function readInstallerData(xml: string): { title?: string; contentId?: string; exe?: string } {
  const title = /<gameTitle>[\s\S]*?<localization[^>]*locale="en_US"[^>]*>([^<]+)</i.exec(xml)?.[1] ?? /<gameTitle>[\s\S]*?<localization[^>]*>([^<]+)</i.exec(xml)?.[1]
  const contentId = /<contentID>\s*([^<\s]+)\s*<\/contentID>/i.exec(xml)?.[1]
  const exe = /<launcher>[\s\S]*?<filePath>([^<]+)<\/filePath>/i.exec(xml)?.[1]
  const exeName = exe ? /([^\\/\]]+\.exe)\s*$/i.exec(exe.trim())?.[1] : undefined
  return { title: title ? decode(title.trim()) : undefined, contentId, exe: exeName }
}

export async function gameFromEa(reg: Record<string, string>, deps: EaDeps): Promise<DetectedGame | null> {
  const dir = (reg['Install Dir'] ?? reg.InstallDir ?? '').replace(/[\\/]+$/, '')
  if (!dir || !deps.exists(dir)) return null
  const xml = await deps.readText(join(dir, '__Installer', 'installerdata.xml'))
  const info = xml ? readInstallerData(xml) : {}
  const title = info.title ?? reg.DisplayName ?? reg.__key
  if (!title) return null
  const game: DetectedGame = { nativeId: info.contentId ?? `ea:${reg.__key}`, title, installDir: dir }
  if (info.exe && deps.exists(join(dir, info.exe))) { game.exe = join(dir, info.exe); game.cwd = dir }
  if (info.contentId) game.uri = `origin2://game/launch/?offerIds=${encodeURIComponent(info.contentId)}`
  return game.exe || game.uri ? game : null
}

export function eaConnector(deps: EaDeps = realEaDeps): Connector {
  return {
    id: 'ea',
    name: 'EA app',
    detect: async () => ((await deps.registryGames()) ?? []).length > 0,
    scan: async () => {
      const games: DetectedGame[] = []
      for (const reg of (await deps.registryGames()) ?? []) {
        const g = await gameFromEa(reg, deps)
        if (g) games.push(g)
      }
      return games
    }
  }
}
