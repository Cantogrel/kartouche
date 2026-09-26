/**
 * BIOS / firmware / clés que l'utilisateur doit fournir lui-même (jamais téléchargés).
 * Un « emplacement » (slot) décrit un fichier attendu par un émulateur et comment le reconnaître.
 */
export type BiosKind = 'bios' | 'firmware' | 'keys'

export interface BiosSlot {
  id: string
  emulator: string
  kind: BiosKind
  /** Sans lui, l'émulateur ne lance pas (ou pas correctement) les jeux de la console. */
  required: boolean
  /** Noms de fichier acceptés (minuscules) ; vide = n'importe quel nom. */
  names?: readonly string[]
  /** Extensions acceptées (minuscules, avec le point) ; vide = n'importe laquelle. */
  exts?: readonly string[]
  /** Tailles acceptées en octets ; vide = n'importe laquelle. */
  sizes?: readonly number[]
  /** Somme MD5 connue → libellé (région, modèle). Un fichier de bonne taille mais de somme inconnue reste accepté « non vérifié ». */
  md5?: Readonly<Record<string, string>>
  /** Taille minimale (firmware : gros fichiers dont on ne calcule pas de somme). */
  minSize?: number
  /** Téléchargeable depuis la source officielle du constructeur (jamais depuis un autre site). */
  auto?: boolean
}

const MB = 1048576

export const BIOS_SLOTS: readonly BiosSlot[] = [
  {
    id: 'ps1', emulator: 'duckstation', kind: 'bios', required: true, exts: ['.bin'], sizes: [512 * 1024],
    md5: {
      '490f666e1afb15b7362b406ed1cea246': 'SCPH-5501 (USA)',
      '8dd7d5296a650fac7319bce665a6a53c': 'SCPH-5500 (Japon)',
      '32736f17079d0b2b7024407c39bd3050': 'SCPH-5502 (Europe)'
    }
  },
  { id: 'ps2', emulator: 'pcsx2', kind: 'bios', required: true, exts: ['.bin'], sizes: [4 * MB] },
  { id: 'ps3', emulator: 'rpcs3', kind: 'firmware', required: true, names: ['ps3updat.pup'], minSize: 100 * MB, auto: true },
  { id: 'vita', emulator: 'vita3k', kind: 'firmware', required: true, names: ['psvupdat.pup'], minSize: 30 * MB, auto: true },
  { id: 'switch-keys', emulator: 'eden', kind: 'keys', required: true, names: ['prod.keys'] },
  { id: 'switch-firmware', emulator: 'eden', kind: 'firmware', required: true, exts: ['.zip'], minSize: 100 * MB },
  { id: 'nds7', emulator: 'melonds', kind: 'bios', required: false, names: ['bios7.bin'], sizes: [16384], md5: { df692a80a5b1bc90728bc3dfc76cd948: 'ARM7' } },
  { id: 'nds9', emulator: 'melonds', kind: 'bios', required: false, names: ['bios9.bin'], sizes: [4096], md5: { a392174eb3e572fed6447e956bde4b25: 'ARM9' } },
  { id: 'ndsfw', emulator: 'melonds', kind: 'bios', required: false, names: ['firmware.bin'], sizes: [131072, 262144, 524288] }
]

export const biosSlotsFor = (emulator: string): BiosSlot[] => BIOS_SLOTS.filter((s) => s.emulator === emulator)

export interface BiosFileInfo {
  name: string
  size: number
  /** MD5 en minuscules, seulement si la taille correspond à un emplacement qui en attend un. */
  md5?: string
}

export type BiosMatch = { slot: BiosSlot; verified: boolean; label?: string }

/** Vrai si le nom et la taille du fichier conviennent à l'emplacement (avant tout calcul de somme). */
export function fitsSlot(slot: BiosSlot, f: Pick<BiosFileInfo, 'name' | 'size'>): boolean {
  const name = f.name.toLowerCase()
  if (slot.names?.length && !slot.names.includes(name)) return false
  const dot = name.lastIndexOf('.')
  if (slot.exts?.length && !slot.exts.includes(dot < 0 ? '' : name.slice(dot))) return false
  if (slot.sizes?.length && !slot.sizes.includes(f.size)) return false
  if (slot.minSize && f.size < slot.minSize) return false
  return true
}

/** Emplacement de l'émulateur auquel correspond le fichier, ou null. `verified` = somme MD5 connue. */
export function matchBios(emulator: string, f: BiosFileInfo): BiosMatch | null {
  for (const slot of biosSlotsFor(emulator)) {
    if (!fitsSlot(slot, f)) continue
    const label = f.md5 && slot.md5?.[f.md5]
    if (slot.md5 && f.md5 && !label) return { slot, verified: false }
    return { slot, verified: !slot.md5 || !!label, label: label || undefined }
  }
  return null
}

/** Vrai si la somme MD5 d'un fichier de cette taille est utile (évite de hacher un firmware de plusieurs centaines de Mo). */
export const needsMd5 = (emulator: string, f: Pick<BiosFileInfo, 'name' | 'size'>): boolean =>
  biosSlotsFor(emulator).some((s) => s.md5 && fitsSlot(s, f))

export interface BiosSlotStatus {
  id: string
  emulator: string
  kind: BiosKind
  required: boolean
  /** ok = présent ; missing = absent ; unavailable = l'émulateur n'est pas installé (son dossier est inconnu). */
  state: 'ok' | 'missing' | 'unavailable'
  /** Présent mais de somme inconnue (non vérifié). */
  unverified?: boolean
  detail?: string
  /** Où il a été trouvé : dans le dossier de BIOS de RomVault, ou déjà configuré dans l'émulateur. */
  source?: 'romvault' | 'emulator'
}

export interface BiosImportResult {
  path: string
  ok: boolean
  slot?: string
  verified?: boolean
  label?: string
  /** unknown = ne correspond à rien ; notInstalled = l'émulateur doit être installé d'abord ; failed = copie ou installation en échec. */
  error?: 'unknown' | 'notInstalled' | 'failed'
  detail?: string
}
