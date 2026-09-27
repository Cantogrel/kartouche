/** Extensions de ROM reconnues → consoles possibles (plusieurs = ambigu, tranché par le hash ou le nom). */
export const ROM_EXTENSIONS: Record<string, readonly string[]> = {
  nes: ['nes'], unf: ['nes'], unif: ['nes'],
  sfc: ['snes'], smc: ['snes'], fig: ['snes'], swc: ['snes'],
  z64: ['n64'], n64: ['n64'], v64: ['n64'],
  gb: ['gb'], gbc: ['gbc'], gba: ['gba'], nds: ['nds'],
  '3ds': ['n3ds'], cci: ['n3ds'], cxi: ['n3ds'], cia: ['n3ds'],
  gc: ['gc'], gcm: ['gc'], gcz: ['gc'], ciso: ['gc'], rvz: ['gc', 'wii'], wbfs: ['wii'], wad: ['wii'],
  wua: ['wiiu'], wud: ['wiiu'], wux: ['wiiu'], rpx: ['wiiu'],
  nsp: ['switch'], xci: ['switch'], nsz: ['switch'], xcz: ['switch'],
  pbp: ['ps1', 'psp'], ecm: ['ps1'], cso: ['ps2', 'psp'], pkg: ['ps3'], vpk: ['vita'],
  iso: ['gc', 'wii', 'ps1', 'ps2', 'ps3', 'psp'], chd: ['ps1', 'ps2'], cue: ['ps1', 'ps2'], bin: ['ps1', 'ps2'], img: ['ps1', 'ps2']
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

export interface LibraryProgress { done: number; total: number; current: string }

export interface SbiImportResult {
  ok: boolean
  /** notPs1 = console sans .sbi ; notFound = jeu introuvable ; badFile = pas un .sbi ; failed = échec de copie. */
  error?: 'notPs1' | 'notFound' | 'badFile' | 'failed'
  detail?: string
}
