import { CONSOLES, consoleById } from './consoles'

/**
 * Émulateurs pris en charge (Windows x64). Chaque console du catalogue a exactement un émulateur.
 * `source` décrit où trouver la dernière version ; `asset` est une expression régulière (source) sur le nom du fichier à télécharger.
 */
export type EmulatorSource =
  | { kind: 'github'; repo: string; asset: string; prerelease?: boolean }
  /** API Forgejo (Eden). */
  | { kind: 'forgejo'; api: string; asset: string }
  | { kind: 'dolphin' }
  /** API officielle de mise à jour de RPCS3 (la liste des releases GitHub n'est pas triée par date). */
  | { kind: 'rpcs3' }
  | { kind: 'retroarch' }

export interface EmulatorDef {
  id: string
  name: string
  /** Consoles du catalogue (ids de `CONSOLES`) que l'émulateur lance. */
  consoles: readonly string[]
  source: EmulatorSource
  /** Noms d'exécutable recherchés (dans l'ordre) dans le dossier d'installation. */
  exe: readonly string[]
  /**
   * Arguments de lancement d'un jeu. `{rom}` = chemin du fichier, `{core}` = cœur RetroArch de la console.
   * Vide = l'émulateur ne sait pas ouvrir un fichier en ligne de commande (il est simplement ouvert).
   */
  args: readonly string[]
  /** Fichier/dossier créé à côté de l'exécutable pour un mode portable (les données restent dans le dossier de l'émulateur). */
  portable?: { file?: string; dir?: string }
  /** Fichiers de BIOS/firmware à importer par l'utilisateur (jamais téléchargés). */
  needsFirmware: boolean
}

/** Cœurs RetroArch par console. */
export const RETROARCH_CORES: Record<string, string> = {
  nes: 'fceumm', snes: 'snes9x', n64: 'mupen64plus_next', gb: 'gambatte', gbc: 'gambatte', gba: 'mgba'
}

export const EMULATORS: readonly EmulatorDef[] = [
  { id: 'retroarch', name: 'RetroArch', consoles: ['nes', 'snes', 'n64', 'gb', 'gbc', 'gba'], source: { kind: 'retroarch' }, exe: ['retroarch.exe'], args: ['-f', '-L', 'cores/{core}_libretro.dll', '{rom}'], needsFirmware: false },
  { id: 'duckstation', name: 'DuckStation', consoles: ['ps1'], source: { kind: 'github', repo: 'stenzek/duckstation', asset: '^duckstation-windows-x64-release\\.zip$' }, exe: ['duckstation-qt-x64-ReleaseLTCG.exe', 'duckstation-qt-x64-Release.exe', 'duckstation-qt.exe'], args: ['-batch', '-fullscreen', '--', '{rom}'], portable: { file: 'portable.txt' }, needsFirmware: true },
  { id: 'dolphin', name: 'Dolphin', consoles: ['gc', 'wii'], source: { kind: 'dolphin' }, exe: ['Dolphin.exe'], args: ['-b', '-e', '{rom}'], portable: { file: 'portable.txt' }, needsFirmware: false },
  { id: 'melonds', name: 'melonDS', consoles: ['nds'], source: { kind: 'github', repo: 'melonDS-emu/melonDS', asset: 'windows-x86_64\\.zip$' }, exe: ['melonDS.exe'], args: ['-f', '{rom}'], needsFirmware: false },
  { id: 'azahar', name: 'Azahar', consoles: ['n3ds'], source: { kind: 'github', repo: 'azahar-emu/azahar', asset: '^azahar-windows-msvc-[\\d.]+\\.zip$' }, exe: ['azahar.exe', 'azahar-qt.exe'], args: ['-f', '{rom}'], portable: { dir: 'user' }, needsFirmware: false },
  { id: 'cemu', name: 'Cemu', consoles: ['wiiu'], source: { kind: 'github', repo: 'cemu-project/Cemu', asset: '^cemu-[\\d.]+-windows-x64\\.zip$' }, exe: ['Cemu.exe'], args: ['-f', '-g', '{rom}'], needsFirmware: false },
  { id: 'eden', name: 'Eden', consoles: ['switch'], source: { kind: 'forgejo', api: 'https://git.eden-emu.dev/api/v1/repos/eden-emu/eden/releases?limit=5', asset: '^Eden-Windows-v[\\w.-]+-amd64-msvc-standard\\.zip$' }, exe: ['eden.exe'], args: ['-f', '-g', '{rom}'], portable: { dir: 'user' }, needsFirmware: true },
  { id: 'pcsx2', name: 'PCSX2', consoles: ['ps2'], source: { kind: 'github', repo: 'PCSX2/pcsx2', asset: '^pcsx2-v[\\d.]+-windows-x64-Qt\\.7z$', prerelease: true }, exe: ['pcsx2-qt.exe'], args: ['-batch', '-fullscreen', '--', '{rom}'], portable: { file: 'portable.txt' }, needsFirmware: true },
  { id: 'rpcs3', name: 'RPCS3', consoles: ['ps3'], source: { kind: 'rpcs3' }, exe: ['rpcs3.exe'], args: ['--no-gui', '{rom}'], needsFirmware: true },
  { id: 'ppsspp', name: 'PPSSPP', consoles: ['psp'], source: { kind: 'github', repo: 'hrydgard/ppsspp', asset: '^PPSSPP-v[\\d.]+-Windows-x64\\.zip$' }, exe: ['PPSSPPWindows64.exe'], args: ['--fullscreen', '{rom}'], portable: { dir: 'memstick' }, needsFirmware: false },
  { id: 'vita3k', name: 'Vita3K', consoles: ['vita'], source: { kind: 'github', repo: 'Vita3K/Vita3K', asset: '^windows-latest\\.zip$', prerelease: true }, exe: ['Vita3K.exe'], args: [], needsFirmware: true }
]

/** Constructeur de l'émulateur (celui de sa première console). */
export const emulatorMaker = (def: EmulatorDef): string | undefined => consoleById(def.consoles[0])?.maker
/** Rang de l'émulateur : celui de sa première console dans le catalogue (ordre de sortie des consoles). */
export const emulatorRank = (def: EmulatorDef): number => CONSOLES.findIndex((c) => c.id === def.consoles[0])

export const emulatorById = (id: string): EmulatorDef | undefined => EMULATORS.find((e) => e.id === id)
export const emulatorForConsole = (console: string): EmulatorDef | undefined => EMULATORS.find((e) => e.consoles.includes(console))

/** Arguments de lancement pour un jeu ; null si la console n'est pas gérée par cet émulateur. */
export function buildArgs(def: EmulatorDef, rom: string, consoleId: string): string[] | null {
  if (!def.consoles.includes(consoleId)) return null
  const core = RETROARCH_CORES[consoleId]
  if (def.id === 'retroarch' && !core) return null
  return def.args.map((a) => a.replace('{rom}', rom).replace('{core}', core ?? ''))
}

/** Compare deux versions numériques (« 1.10.2 » > « 1.9 ») ; les textes non numériques comptent pour 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export interface EmulatorState {
  id: string
  installed: boolean
  version: string | null
  /** Dossier d'installation (ou dossier de l'exécutable indiqué à la main). */
  dir: string | null
  exe: string | null
  /** Exécutable choisi à la main plutôt qu'installé par RomVault. */
  custom: boolean
  installedAt: number | null
  /** Le fichier exécutable n'existe plus. */
  missing: boolean
}

export interface EmulatorProgress {
  id: string
  phase: 'resolve' | 'download' | 'extract' | 'cores' | 'firmware' | 'done' | 'error'
  done: number
  total: number
  message?: string
}

export interface LatestVersion { id: string; version: string | null; error?: string }

export interface LaunchResult { ok: boolean; error?: 'noEmulator' | 'notInstalled' | 'noFile' | 'spawn' | 'unsupported' | 'running'; detail?: string }

/** Présent quand le jeu s'est fermé (ou a planté) très vite après son lancement, sans que l'utilisateur ne l'ait fermé lui-même. */
export interface QuickExit { elapsedMs: number; log?: string }

export interface GameSession { entryId: number; running: boolean; playMinutes?: number; quickExit?: QuickExit }

/**
 * Signatures reconnues dans le journal d'un lancement raté, indépendamment de l'émulateur qui les a émises (clé i18n `play.*`).
 * Une entrée plus spécifique doit passer avant une plus générale (SBI avant BIOS : un message SBI cite parfois le mot « BIOS »).
 */
const KNOWN_FAILURES: readonly { pattern: RegExp; key: string }[] = [
  { pattern: /subq|\.sbi\b/i, key: 'play.quickExitSbi' },
  { pattern: /bios.*(missing|invalid|not found|refused)|no bios|aucun bios/i, key: 'play.quickExitBios' },
  { pattern: /firmware.*(missing|invalid|not found)/i, key: 'play.quickExitFirmware' }
]

/** Clé i18n d'une cause connue reconnue dans le journal, ou undefined si rien de reconnu (le journal brut reste la seule piste). */
export function explainFailure(log: string | undefined): string | undefined {
  if (!log) return undefined
  return KNOWN_FAILURES.find((f) => f.pattern.test(log))?.key
}
