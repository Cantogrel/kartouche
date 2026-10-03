import { basename, extname } from 'node:path'
import { switchContentFromFilename } from '../switchContent'
import { probeCia } from './n3ds'
import { probePkg } from './pkg'
import { probeVitaArchive } from './vita'
import { probeWua } from './wua'
import { cleanLabel, probeNsp } from './switch'
import { probeWiiUFolder } from './wiiu'
import type { ContentInfo, ProbeContext } from './types'

export { probeWiiUFolder }

/**
 * Extensions qui ne sont pas des ROM mais peuvent être un contenu additionnel : l'importer les accepte pour les passer à `probeFile`, et une fois
 * identifiées elles ne deviennent JAMAIS un jeu de la bibliothèque (un jeu de base `.pkg` est refusé).
 */
export const CONTENT_EXTENSIONS: readonly string[] = ['pkg']

/**
 * Identité d'un fichier d'après son format : null si ce format n'a pas de notion de contenu additionnel ou n'est pas reconnu (le fichier suit alors
 * le chemin d'une ROM ordinaire). Le format décide, jamais l'extension seule : un `.nsp` illisible reste un jeu, un `.pkg` illisible est refusé par l'appelant.
 */
export async function probeFile(path: string, ctx: ProbeContext = {}): Promise<ContentInfo | null> {
  switch (extname(path).toLowerCase()) {
    // NSP : conteneur lu d'abord ; s'il est illisible (pas un PFS0), le nom reste un repère faible — mieux vaut un contenu « orphelin » qu'un faux jeu.
    case '.nsp': return (await probeNsp(path, ctx)) ?? filenameInfo(path)
    // XCI : pas de lecture du conteneur (partitions HFS0) ; seul le Title ID du nom, convention des dumps, sert de repère.
    case '.xci': return filenameInfo(path)
    case '.cia': return probeCia(path)
    case '.pkg': return probePkg(path)
    // Archive Wii U (ZArchive) : ses dossiers racine « <Title ID>_v<version> » disent si elle contient le jeu, ou seulement une mise à jour / des DLC.
    case '.wua': return probeWua(path)
    // Archive Vita : son PARAM.SFO dit si c'est le jeu, sa mise à jour ou un DLC (un .zip sans PARAM.SFO n'est pas concerné : une ROM ordinaire).
    case '.vpk':
    case '.zip': return probeVitaArchive(path)
    default: return null
  }
}

/** Identité d'après le seul nom du fichier (Title ID entre crochets, ou mot « update »/« DLC ») — source `filename`, la plus faible. */
export function filenameInfo(path: string): ContentInfo | null {
  const stem = basename(path).replace(/\.[^.]+$/, '')
  const named = switchContentFromFilename(stem)
  return named && { console: 'switch', kind: named.kind, titleId: named.titleId, baseKey: named.baseTitleId, version: null, source: 'filename', label: cleanLabel(stem) }
}
