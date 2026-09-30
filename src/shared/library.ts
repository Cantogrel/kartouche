import { CONSOLES } from './consoles'

/** Extensions de ROM reconnues → consoles possibles (plusieurs = ambigu, tranché par le hash ou le nom). */
export const ROM_EXTENSIONS: Record<string, readonly string[]> = {
  nes: ['nes'], unf: ['nes'], unif: ['nes'],
  sfc: ['snes'], smc: ['snes'], fig: ['snes'], swc: ['snes'],
  z64: ['n64'], n64: ['n64'], v64: ['n64'],
  gb: ['gb'], gbc: ['gbc'], gba: ['gba'], nds: ['nds'],
  '3ds': ['n3ds'], cci: ['n3ds'], cxi: ['n3ds'], cia: ['n3ds'],
  // Pas de « gc » (n'existe pas : Dolphin ne connaît que .gcm/.iso/.gcz/.ciso/.rvz/.wia pour un dump GameCube, jamais
  // une extension .gc nue — vérifié dans la liste d'extensions du binaire de Dolphin, aucune trace ailleurs non plus).
  gcm: ['gc'], gcz: ['gc'], ciso: ['gc'], rvz: ['gc', 'wii'], wbfs: ['wii'], wad: ['wii'],
  wua: ['wiiu'], wud: ['wiiu'], wux: ['wiiu'], rpx: ['wiiu'],
  // Pas de .nsz/.xcz : formats compressés qu'Eden ne sait pas ouvrir (vérifié : aucune trace dans son binaire), il
  // faudrait les décompresser en .nsp/.xci avant import (outil externe « nsz ») — jamais implémenté ici.
  nsp: ['switch'], xci: ['switch'],
  // Pas de .pkg : RPCS3 a besoin de l'installer d'abord (--installpkg, vérifié dans son binaire, distinct du boot
  // direct --no-gui) — même famille de piège que le .vpk Vita3K, jamais vérifié faute d'un vrai fichier .pkg. .iso
  // fonctionne directement pour PS3, en attendant une vraie investigation si le besoin se présente.
  pbp: ['ps1', 'psp'], ecm: ['ps1'], cso: ['ps2', 'psp'], vpk: ['vita'],
  // .img : legitime seulement pour PS1 (DuckStation) — absent de la liste de formats de PCSX2 (PS2).
  iso: ['gc', 'wii', 'ps1', 'ps2', 'ps3', 'psp'], chd: ['ps1', 'ps2'], cue: ['ps1', 'ps2'], bin: ['ps1', 'ps2'], img: ['ps1']
}

/** Extensions de ROM acceptées pour un ensemble de consoles (+ `.zip`, toujours accepté). Triées, sans doublon. */
export function extensionsForConsoles(consoles: readonly string[]): string[] {
  const set = new Set<string>(['zip'])
  for (const [ext, consoleList] of Object.entries(ROM_EXTENSIONS)) if (consoleList.some((c) => consoles.includes(c))) set.add(ext)
  return [...set].sort()
}

export type MatchKind = 'hash' | 'name' | 'none'

export interface LibraryEntry {
  id: number
  /** Jeu du catalogue reconnu ; null si le fichier n'a pas pu être identifié. */
  gameId: number | null
  console: string
  title: string
  path: string
  size: number
  match: MatchKind
  /** Le fichier n'existe plus à `path`. */
  missing: boolean
  addedAt: number
  playMinutes: number
  lastPlayed: number | null
  favorite: boolean
  /** Épinglé en tête de la liste latérale. */
  pinned: boolean
  /** Ids des collections auxquelles le jeu appartient. */
  collections: number[]
}

export interface Collection { id: number; name: string; count: number }

/**
 * Consoles présentes dans la bibliothèque, triées par jeu le plus récemment lancé en tête (la console du tout
 * dernier lancement passe première) ; les consoles sans aucun historique de lancement suivent, dans l'ordre du
 * catalogue (`CONSOLES` : Nintendo puis Sony, chronologique).
 */
export function orderConsolesByRecency(entries: readonly LibraryEntry[]): string[] {
  const lastPlayedByConsole = new Map<string, number>()
  for (const e of entries) {
    if (e.lastPlayed === null) continue
    const prev = lastPlayedByConsole.get(e.console)
    if (prev === undefined || e.lastPlayed > prev) lastPlayedByConsole.set(e.console, e.lastPlayed)
  }
  const catalogRank = new Map(CONSOLES.map((c, i) => [c.id, i]))
  const [withHistory, withoutHistory] = [[], []] as [string[], string[]]
  for (const c of new Set(entries.map((e) => e.console))) (lastPlayedByConsole.has(c) ? withHistory : withoutHistory).push(c)
  withHistory.sort((a, b) => lastPlayedByConsole.get(b)! - lastPlayedByConsole.get(a)!)
  withoutHistory.sort((a, b) => (catalogRank.get(a) ?? Infinity) - (catalogRank.get(b) ?? Infinity))
  return [...withHistory, ...withoutHistory]
}

/** Mise à jour ou DLC Switch (identifié par Title ID) rattaché à un jeu de la bibliothèque plutôt que listé à part. */
export interface LibraryContentItem {
  id: number
  kind: 'update' | 'dlc'
  /** Vide si le dump n'a pas de Title ID lisible (rattaché par nom). */
  titleId: string | null
  version: string | null
  label: string
  size: number
  addedAt: number
}

export type ImportStatus = 'added' | 'duplicate' | 'ambiguous' | 'error'

export interface ImportItem {
  file: string
  status: ImportStatus
  console?: string
  title?: string
  match?: MatchKind
  error?: string
}

export interface ImportRequest {
  paths: string[]
  /** Surcharge le réglage « supprimer le fichier d'origine ». */
  deleteSource?: boolean
}

export interface ImportResult {
  items: ImportItem[]
  /** Fichiers d'extension non reconnue rencontrés dans un dossier (ignorés sans bruit). */
  ignored: number
}

/** bytesDone/bytesTotal : avancement dans le fichier en cours (empreinte + copie), pour qu'un import d'un seul gros
 * fichier (ex. une ROM Switch de plusieurs Go) ne reste pas visuellement figé entre le début et la fin. */
export interface LibraryProgress { done: number; total: number; current: string; bytesDone?: number; bytesTotal?: number }

export interface SbiImportResult {
  ok: boolean
  /** notPs1 = console sans .sbi ; notFound = jeu introuvable ; badFile = pas un .sbi ; failed = échec de copie. */
  error?: 'notPs1' | 'notFound' | 'badFile' | 'failed'
  detail?: string
}
