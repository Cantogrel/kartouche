import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'

/*
 * Xbox / Microsoft Store : lit seulement, dans chaque dossier `<disque>:\XboxGames\<jeu>\Content`, le `appxmanifest.xml` (identité du paquet, nom affiché,
 * application) et `MicrosoftGame.Config` (nom affiché de repli). Lancement par `shell:AppsFolder\<paquet>!<application>`, comme le menu Démarrer.
 */

export interface XboxDeps {
  /** Dossiers `XboxGames` existants (un par disque). */
  roots(): string[]
  listDir(path: string): Promise<string[]>
  readText(path: string): Promise<string | null>
}

export const realXboxDeps: XboxDeps = {
  roots: () => 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\XboxGames`).filter((p) => existsSync(p)),
  listDir: (p) => readdir(p).catch(() => []),
  readText: (p) => readFile(p, 'utf-8').catch(() => null)
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** Identifiant d'éditeur d'un paquet (les 13 caractères après le « _ » du nom de famille) : SHA-256 de l'éditeur en UTF-16, 64 bits, base 32. */
export function publisherId(publisher: string): string {
  const hash = createHash('sha256').update(Buffer.from(publisher, 'utf16le')).digest().subarray(0, 8)
  let bits = ''
  for (const b of hash) bits += b.toString(2).padStart(8, '0')
  bits += '0'
  let out = ''
  for (let i = 0; i < 13; i++) out += ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]
  return out
}

const decode = (s: string): string => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
const attr = (tag: string, name: string): string | undefined => { const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag); return m ? decode(m[1]) : undefined }
const element = (xml: string, name: string): string | undefined => new RegExp(`<${name}\\b[^>]*>`, 'i').exec(xml)?.[0]

/** Jeu décrit par le manifeste du paquet (et sa configuration Xbox facultative) ; null s'il manque l'identité ou l'application. */
export function gameFromXboxPackage(manifest: string, config: string | null, folderName: string, contentDir: string): DetectedGame | null {
  const identity = element(manifest, 'Identity')
  const name = identity && attr(identity, 'Name')
  const publisher = identity && attr(identity, 'Publisher')
  const application = element(manifest, 'Application')
  const appId = application && attr(application, 'Id')
  if (!name || !publisher || !appId) return null
  let title = /<DisplayName>([^<]+)<\/DisplayName>/i.exec(manifest)?.[1]?.trim()
  if (!title || /^ms-resource:/i.test(title)) {
    const visual = config ? element(config, 'ShellVisuals') : undefined
    const configured = visual && attr(visual, 'DefaultDisplayName')
    title = configured && !/^ms-resource:/i.test(configured) ? configured : folderName
  }
  return { nativeId: `${name}_${publisherId(publisher)}`, title: decode(title), installDir: contentDir, uri: `shell:AppsFolder\\${name}_${publisherId(publisher)}!${appId}` }
}

export function xboxConnector(deps: XboxDeps = realXboxDeps): Connector {
  return {
    id: 'xbox',
    name: 'Xbox / Microsoft Store',
    detect: async () => deps.roots().length > 0,
    scan: async () => {
      const games: DetectedGame[] = []
      for (const root of deps.roots()) {
        for (const folder of await deps.listDir(root)) {
          const content = join(root, folder, 'Content')
          const manifest = await deps.readText(join(content, 'appxmanifest.xml'))
          if (!manifest) continue
          const g = gameFromXboxPackage(manifest, await deps.readText(join(content, 'MicrosoftGame.Config')), folder, content)
          if (g) games.push(g)
        }
      }
      return games
    }
  }
}
