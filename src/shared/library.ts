import { CONSOLES } from './consoles'
import type { EntryKind } from './launch'
import type { OverrideField } from './overrides'

/** Extensions de ROM reconnues → consoles possibles (plusieurs = ambigu, tranché par le hash ou le nom). */
export const ROM_EXTENSIONS: Record<string, readonly string[]> = {
  nes: ['nes'], unf: ['nes'], unif: ['nes'],
  sfc: ['snes'], smc: ['snes'], fig: ['snes'], swc: ['snes'],
  z64: ['n64'], n64: ['n64'], v64: ['n64'],
  gb: ['gb'], gbc: ['gbc'], gba: ['gba'],
  // .dsi/.srl/.ids : variantes NDS/DSi reconnues par melonDS au même titre que .nds (vérifié dans son binaire,
  // liste d'extensions contiguë .gba/.agb/.nds/.srl/.dsi/.ids — .agb exclu, c'est le slot GBA de la DS, pas la console GBA).
  nds: ['nds'], dsi: ['nds'], srl: ['nds'], ids: ['nds'],
  // .zcci : CCI compressé, reconnu par Azahar au même titre que .cci (vérifié dans son binaire).
  '3ds': ['n3ds'], cci: ['n3ds'], cxi: ['n3ds'], cia: ['n3ds'], zcci: ['n3ds'],
  // Pas de « gc » (n'existe pas : Dolphin ne connaît que .gcm/.iso/.gcz/.ciso/.rvz/.wia/.tgc/.nfs/.wbfs/.wad pour un
  // dump GC/Wii, jamais une extension .gc nue — vérifié dans la liste d'extensions ET les filtres de fichiers du
  // binaire de Dolphin). .wia (WIA GC/Wii images) et .tgc (GameCube trimmé) existent pour les deux consoles comme
  // .rvz ; .nfs (dump Wii extrait d'une archive Wii U eShop) n'existe que pour Wii.
  gcm: ['gc'], gcz: ['gc'], ciso: ['gc'], rvz: ['gc', 'wii'], wia: ['gc', 'wii'], tgc: ['gc', 'wii'], nfs: ['wii'],
  wbfs: ['wii'], wad: ['wii', 'wiiu'],
  // .iso et .wad (Wii U) : vérifiés dans les filtres de fichiers du binaire de Cemu (« Wii U image (*.wud, *.wux,
  // *.iso, *.wad) »), au même titre que .wud/.wux/.wua/.rpx déjà reconnus.
  wua: ['wiiu'], wud: ['wiiu'], wux: ['wiiu'], rpx: ['wiiu'],
  // Pas de .nsz/.xcz : formats compressés qu'Eden ne sait pas ouvrir (vérifié : aucune trace dans son binaire). Le .nsz est
  // accepté à l'import MAIS décompressé en .nsp d'abord (library/nsz.ts) ; le .xcz n'est pas pris en charge.
  nsp: ['switch'], xci: ['switch'],
  // Pas de .pkg : RPCS3 a besoin de l'installer d'abord (--installpkg, vérifié dans son binaire, distinct du boot
  // direct --no-gui) — même famille de piège que le .vpk Vita3K, jamais vérifié faute d'un vrai fichier .pkg. .iso
  // fonctionne directement pour PS3, en attendant une vraie investigation si le besoin se présente.
  pbp: ['ps1', 'psp'], ecm: ['ps1'], cso: ['ps2', 'psp'], vpk: ['vita'],
  // .mds/.ccd/.psx : vérifiés dans le filtre de fichiers de DuckStation, même famille que .cue/.bin/.ecm déjà reconnus
  // (« Media Descriptor Sidecar Images », « CloneCD Images », alias .psx pour une image brute mono-piste).
  mds: ['ps1'], ccd: ['ps1'], psx: ['ps1'],
  // .mdf/.zso/.gz : vérifiés dans le filtre de fichiers de PCSX2 (« Media Descriptor File », « ZSO Images »,
  // « Gzip Compressed ISO »), même famille que .cso/.chd déjà reconnus. .gz est générique (n'importe quel fichier
  // gzippé) mais c'est le format officiellement listé par PCSX2 ; une extension ambiguë est déjà le cas pour .bin/.iso.
  mdf: ['ps2'], zso: ['ps2'], gz: ['ps2'],
  // .img : legitime seulement pour PS1 (DuckStation) — absent de la liste de formats de PCSX2 (PS2).
  // .chd pour psp : ajouté par PPSSPP (vérifié dans son binaire), au même titre que ps1/ps2.
  iso: ['gc', 'wii', 'wiiu', 'ps1', 'ps2', 'ps3', 'psp'], chd: ['ps1', 'ps2', 'psp'], cue: ['ps1', 'ps2'], bin: ['ps1', 'ps2'], img: ['ps1']
}

/** Extensions de ROM acceptées pour un ensemble de consoles (+ `.zip`, toujours accepté). Triées, sans doublon. */
export function extensionsForConsoles(consoles: readonly string[]): string[] {
  const set = new Set<string>(['zip'])
  for (const [ext, consoleList] of Object.entries(ROM_EXTENSIONS)) if (consoleList.some((c) => consoles.includes(c))) set.add(ext)
  return [...set].sort()
}

/**
 * 'source' : empreinte vérifiée contre celle déclarée par une liste de sources (téléchargement), pas contre le DAT
 * officiel — cas d'une ROM volontairement modifiée (patch, traduction…) dont le hash ne peut jamais correspondre au
 * catalogue. 'unverified' : téléchargement installé sans empreinte de référence utilisable (liste sans hash déclaré
 * pour cette entrée, ou hash déclaré qui ne correspond pas) — rattaché au jeu que la liste avait déjà associé à
 * cette entrée (rapprochement par titre), sous la responsabilité de son auteur comme toute liste ajoutée par
 * l'utilisateur.
 */
export type MatchKind = 'hash' | 'name' | 'source' | 'unverified' | 'none'

export interface LibraryEntry {
  id: number
  /** Jeu du catalogue reconnu ; null si le fichier n'a pas pu être identifié. */
  gameId: number | null
  console: string
  /** Titre d'origine (reconnaissance, sauvegardes, téléchargements) : ne JAMAIS l'afficher à la place de `shownTitle`, ni utiliser `shownTitle` pour identifier. */
  title: string
  /** Titre à afficher : celui de l'utilisateur s'il l'a modifié (voir shared/overrides.ts), sinon `title`. */
  shownTitle: string
  /** Champs modifiés par l'utilisateur sur ce jeu. */
  overridden: OverrideField[]
  /** `rom` (défaut), ou `exe` / `launcher` : entrée non-ROM, sans console du catalogue (`console` vaut alors `pc`) ; ses fichiers ne sont jamais supprimés par Kartouche. */
  kind: EntryKind
  /** D'où vient une entrée non-ROM (`manual`, `steam`…) ; null pour une ROM. */
  source: string | null
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
  /** Au moins une liste de sources propose un téléchargement pour ce jeu (bouton/action « Désinstaller »). */
  hasSources: boolean
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

/** Mise à jour ou DLC (identifié par l'identifiant natif de la plateforme) rattaché à un jeu de la bibliothèque plutôt que listé à part. */
export interface LibraryContentItem {
  id: number
  kind: 'update' | 'dlc'
  /** Identifiant natif du contenu (Title ID, ou identifiant de contenu PS3/Vita) ; null si inconnu (dump sans identifiant lisible). */
  titleId: string | null
  version: string | null
  label: string
  size: number
  addedAt: number
  /** `installed` : l'émulateur le voit ; `pending` : sera installé automatiquement (voir `reason`) ; `failed` : échec, nouvelle tentative au prochain lancement. */
  state: 'installed' | 'pending' | 'failed'
  /** Pourquoi `pending` : `onLaunch`, `emulatorMissing`, `emulatorRunning`, `needsKey`, `unsupported`, `error`. */
  reason: string | null
  /** Clé fournie par l'utilisateur dont l'installation dépend (`license`) ; sert à expliquer l'attente. */
  needs: string | null
  detail: string | null
}

/**
 * `attached` : mise à jour/DLC rattaché à son jeu (pas une ligne de bibliothèque) ; `orphan` : mise à jour/DLC dont le jeu n'est pas (encore) dans la
 * bibliothèque : le fichier n'est ni importé ni supprimé, il sera rattaché dès que le jeu sera importé.
 */
export type ImportStatus = 'added' | 'duplicate' | 'ambiguous' | 'error' | 'attached' | 'orphan'

export interface ImportItem {
  file: string
  status: ImportStatus
  console?: string
  title?: string
  match?: MatchKind
  error?: string
  /** Pour `attached` : sorte de contenu et jeu parent (titre de la bibliothèque). */
  contentKind?: 'update' | 'dlc'
  parent?: string
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

/** Consoles qui ont des mises à jour/DLC gérés par Kartouche (voir `library/content/`) : leur fiche propose l'import et la désinstallation unitaires. */
export const CONTENT_CONSOLES: readonly string[] = ['switch', 'n3ds', 'ps3', 'wiiu', 'vita']
