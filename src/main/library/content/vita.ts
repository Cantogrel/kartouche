import { basename } from 'node:path'
import { sfoString } from '../../emulators/rpcs3'
import { readZip, readZipEntryHead } from '../hash'
import type { ContentInfo } from './types'

// Archive Vita (.vpk ou .zip contenant `sce_sys/param.sfo`) : le PARAM.SFO — en clair dans l'archive — dit ce que c'est (CATEGORY : `gd` application, `gp` mise à jour, `ac` contenu
// additionnel), de quel jeu (TITLE_ID) et, pour un DLC, son identifiant de contenu. Même lecture que Vita3K à l'installation (`interface.cpp`, `install_archive_content`).

const SFO_RE = /(^|\/)sce_sys\/param\.sfo$/i
const SERIAL_RE = /^[A-Z]{4}\d{5}$/

export interface VitaArchiveInfo {
  category: string
  titleId: string
  contentId: string
  version: string | null
  /** Préfixe commun des entrées de l'archive (vide pour un .vpk : `sce_sys/` à la racine). */
  root: string
  entries: { name: string; size: number }[]
}

/** Lecture du PARAM.SFO d'une archive ; null si ce n'est pas une archive de contenu Vita lisible. Plusieurs contenus dans une même archive : `many`. */
export async function readVitaArchive(path: string): Promise<VitaArchiveInfo | 'many' | null> {
  const all = await readZip(path).catch(() => null)
  if (!all) return null
  const sfos = all.filter((e) => SFO_RE.test(e.name))
  if (sfos.length === 0) return null
  const roots = [...new Set(sfos.map((e) => e.name.slice(0, e.name.length - 'sce_sys/param.sfo'.length)))]
  if (roots.length > 1) return 'many'
  const head = await readZipEntryHead(path, sfos[0].name, 64 * 1024)
  if (!head) return null
  const category = sfoString(head, 'CATEGORY')
  const titleId = sfoString(head, 'TITLE_ID')
  if (!category || !titleId || !SERIAL_RE.test(titleId)) return null
  const root = roots[0]
  return {
    category, titleId, contentId: sfoString(head, 'CONTENT_ID') ?? '', version: sfoString(head, 'APP_VER'),
    root, entries: all.filter((e) => e.name.startsWith(root) && !e.name.endsWith('/')).map((e) => ({ name: e.name.slice(root.length), size: e.size }))
  }
}

/** Identité d'une archive Vita : jeu (`gd`, importé comme une ROM), mise à jour (`gp`), DLC (`ac`) ; null si ce n'est pas une archive Vita. */
export async function probeVitaArchive(file: string): Promise<ContentInfo | null> {
  const info = await readVitaArchive(file)
  if (!info) return null
  const label = basename(file).replace(/\.[^.]+$/, '')
  const unknown = (reason: string): ContentInfo => ({ console: 'vita', kind: 'unknown', titleId: '', baseKey: '', version: null, source: 'container', label, reason })
  if (info === 'many') return unknown("plusieurs contenus dans une même archive : à séparer avant l'import")
  switch (info.category) {
    case 'gd': return { console: 'vita', kind: 'base', titleId: info.titleId, baseKey: info.titleId, version: info.version, source: 'container', label }
    case 'gp': return { console: 'vita', kind: 'update', titleId: `${info.titleId}:${info.version ?? '?'}`, baseKey: info.titleId, version: info.version, source: 'container', label }
    case 'ac': return { console: 'vita', kind: 'dlc', titleId: info.contentId || info.titleId, baseKey: info.titleId, version: info.version, source: 'container', label }
    default: return unknown(`catégorie Vita non prise en charge (${info.category})`)
  }
}
