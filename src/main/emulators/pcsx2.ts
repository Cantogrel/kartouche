import { readDiscRootFile } from './disc'
import type { Gpu, GpuTier } from './gpu'

// Réglages PCSX2 qui dépendent du matériel et du jeu. Données pures : configure.ts les écrit dans `inis/PCSX2.ini` (fusion, jamais d'écrasement des
// réglages de l'utilisateur). Vérifié sur PCSX2 2.9.93 lancé avec un vrai jeu (journal détaillé : `logs/emulog.txt`).
//
// Fichiers et mécanismes :
// - `inis/PCSX2.ini` : configuration globale ([EmuCore/GS] rendu, [Pad1] manette, [InputSources], [Folders]…) ;
// - `gamesettings/<SERIE>_<CRC>.ini` : réglages par jeu natifs, même disposition que PCSX2.ini ; le CRC est celui de l'exécutable du jeu (voir `ps2ElfCrc`) ;
//   `[EmuCore] InputProfileName = <nom>` y désigne un profil de manette de `inputprofiles/<nom>.ini` (vérifié : « Loading input profile from … ») ;
// - PCSX2 applique lui-même les correctifs de sa base de jeux (« GameDB: Enabled GS Hardware Fix … ») et les patchs `.pnach` : on n'y touche pas ;
// - cache de shaders et de pipelines Vulkan : natifs, toujours actifs (`cache/vulkan_shaders.idx`, `vulkan_pipelines.bin`), rien à régler.

export type Ini = Record<string, Record<string, string | number | boolean>>

// --- Rendu --------------------------------------------------------------------------------------------------------------

/** Valeurs de `Renderer` (GSRendererType), vérifiées au journal : 14 = Vulkan, 3 = Direct3D 11 (le repli : d'abord le plus répandu sous Windows). */
export const PCSX2_RENDERER = { vulkan: 14, d3d11: 3 } as const

/**
 * PCSX2 étiquette « 3x Native (~1080p) », « 4x (~1440p) », « 6x (~2160p) » : le facteur suit l'écran sur ces étiquettes (une image PS2 fait ~360 lignes de
 * « 1x » dans ce calcul), borné par le GPU — iGPU 2x, petite carte 3x, moyenne 4x.
 */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 2, low: 3, mid: 4, high: 8 }
export const pcsx2Scale = (gpu: Gpu, displayHeight: number): number => Math.max(1, Math.min(TIER_MAX_SCALE[gpu.tier], Math.round(displayHeight / 360)))

/**
 * Section [EmuCore/GS] : Vulkan si le pilote le gère, sinon Direct3D 11, sur le GPU détecté (`Adapter` = son nom ; un nom inconnu retombe sur le premier
 * GPU, vérifié), à la résolution adaptée. Ni hack, ni widescreen (le ratio auto 4:3 reste, `AspectRatio` et `EnableWideScreenPatches` ne sont pas touchés).
 */
export function pcsx2Gs(gpu: Gpu, displayHeight: number): Record<string, string | number | boolean> {
  const gs: Record<string, string | number | boolean> = {
    Renderer: gpu.vulkan ? PCSX2_RENDERER.vulkan : PCSX2_RENDERER.d3d11,
    upscale_multiplier: pcsx2Scale(gpu, displayHeight)
  }
  if (gpu.name) gs.Adapter = gpu.name
  return gs
}

// --- Exceptions par jeu -------------------------------------------------------------------------------------------------

/**
 * Réglages propres à un jeu, indexés par numéro de série (« SLES-52541 ») : écrits dans `gamesettings/<SERIE>_<CRC>.ini`, qui prime sur PCSX2.ini pour CE jeu
 * seulement. Chaque valeur est une disposition ini comme PCSX2.ini : `[EmuCore/GS]` (upscale_multiplier, AspectRatio, UserHacks_*), `[EmuCore]`
 * (`EnableWideScreenPatches`, `InputProfileName`)… Vide pour l'instant : seules des exceptions confirmées y ont leur place. Un fichier déjà présent (créé par
 * l'utilisateur dans PCSX2) n'est jamais modifié.
 */
export const PCSX2_GAME_OVERRIDES: Record<string, Ini> = {}

/**
 * Profils de manette réutilisables (`inputprofiles/<nom>.ini`, chargeables dans PCSX2 ou désignés par `InputProfileName` d'un jeu). La disposition SDL est celle
 * de la configuration globale (voir configure.ts) ; le profil clavier ne garde que les touches.
 */
export const PCSX2_PROFILE_NAMES = { pad: 'RomVault Manette', keyboard: 'RomVault Clavier' } as const

// --- Identification du jeu ----------------------------------------------------------------------------------------------

export interface Ps2Game { serial: string; crc: string }

/** Numéro de série (« SLES-52541 ») d'une ligne `BOOT2 = cdrom0:\SLES_525.41;1`. */
export function ps2SerialFromBoot(boot: string): string | null {
  const m = /([A-Z]{4})[_-](\d{3})\.?(\d{2})/i.exec(boot.replace(/^.*[\\/:]/, ''))
  return m ? `${m[1].toUpperCase()}-${m[2]}${m[3]}` : null
}

/** CRC de l'exécutable : OU exclusif de tous ses mots de 32 bits (little-endian) — c'est la valeur « Game CRC » que PCSX2 journalise, vérifiée sur un vrai disque. */
export function ps2ElfCrc(elf: Buffer): string {
  let x = 0
  for (let i = 0; i + 4 <= elf.length; i += 4) x ^= elf.readUInt32LE(i)
  return (x >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/** Numéro de série et CRC d'un jeu PS2 (.iso, ou .bin/.cue) dont l'exécutable est à la racine du disque ; null sinon (.chd, .cso, exécutable en sous-dossier…). */
export async function readPs2Game(path: string): Promise<Ps2Game | null> {
  const cnf = await readDiscRootFile(path, (n) => /^SYSTEM\.CNF/i.test(n), 2048).catch(() => null)
  const boot = cnf ? /^\s*BOOT2\s*=\s*(\S+)/im.exec(cnf.data.toString('latin1'))?.[1] : undefined
  if (!boot) return null
  const serial = ps2SerialFromBoot(boot)
  const file = boot.replace(/^.*[\\/:]/, '').replace(/;\d+$/, '').toUpperCase()
  const elf = serial ? await readDiscRootFile(path, (n) => n.toUpperCase().replace(/;\d+$/, '') === file, 64 * 1024 * 1024).catch(() => null) : null
  return serial && elf ? { serial, crc: ps2ElfCrc(elf.data) } : null
}
