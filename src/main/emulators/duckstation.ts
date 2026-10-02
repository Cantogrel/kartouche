import { readDiscRootFile } from './disc'
import type { Gpu, GpuTier } from './gpu'

// Réglages DuckStation qui dépendent du matériel et du jeu. Données pures : configure.ts les écrit dans `settings.ini` (fusion, jamais d'écrasement des
// réglages de l'utilisateur). Vérifié sur DuckStation 0.1.11894 lancé avec un vrai jeu (journal détaillé) et dans son code source (core/settings.cpp,
// analog_controller.cpp, system.cpp).
//
// Fichiers et mécanismes :
// - `settings.ini` : configuration globale ([GPU], [Audio], [Pad1], [InputSources]…) ;
// - `gamesettings/<SERIE>.ini` : réglages par jeu natifs, même disposition que settings.ini, nommés d'après le numéro de série du disque (« SCES-01438 ») ;
//   pour les manettes, il faut en plus `[ControllerPorts] UseGameSettingsForController = true` (+ `InputProfileName` pour un profil de `inputprofiles/`) ;
// - DuckStation applique lui-même des réglages recommandés par jeu depuis sa base interne (ex. PGXP « culling » ou « CPU » pour un jeu connu) : on n'y touche pas.

export type Ini = Record<string, Record<string, string | number | boolean>>

// --- Rendu --------------------------------------------------------------------------------------------------------------

/** Hauteur de l'image de la PS1 (240 lignes) : un facteur n rend 240 n lignes. */
const PS1_HEIGHT = 240

/** Facteur maximal par niveau de GPU : les iGPU et petites cartes restent raisonnables (PGXP et résolution cumulent leur coût). */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 2, low: 3, mid: 6, high: 16 }

/** Facteur de résolution : le plus petit qui remplit la hauteur de l'écran (5x sur 1080p, 6x sur 1440p, 9x sur 4K), borné par le GPU. */
export const duckstationScale = (gpu: Gpu, displayHeight: number): number =>
  Math.max(1, Math.min(TIER_MAX_SCALE[gpu.tier], Math.ceil((displayHeight * 0.95) / PS1_HEIGHT)))

/**
 * Section [GPU] : Vulkan si le pilote le gère (sinon Direct3D 11, l'API la plus répandue sous Windows, vérifié fonctionnel), sur le GPU détecté
 * (`Adapter` = son nom ; un nom inconnu retombe sur le premier GPU, vérifié). PGXP : correction de géométrie, des textures et « culling » (sûrs), plus le
 * tampon de profondeur (tampon réel, vérifié actif en Vulkan) dès qu'on est au-dessus d'un iGPU. Jamais : mode CPU, cache de sommets, ni widescreen
 * (le 4:3 natif reste, `Display.AspectRatio` n'est pas touché) — DuckStation active lui-même ce qu'un jeu connu exige.
 */
export function duckstationGpu(gpu: Gpu, displayHeight: number): Record<string, string | number | boolean> {
  const gpuSection: Record<string, string | number | boolean> = {
    Renderer: gpu.vulkan ? 'Vulkan' : 'D3D11',
    ResolutionScale: duckstationScale(gpu, displayHeight),
    PGXPEnable: true, PGXPCulling: true, PGXPTextureCorrection: true, PGXPDepthBuffer: gpu.tier !== 'igpu'
  }
  if (gpu.vulkan && gpu.name) gpuSection.Adapter = gpu.name
  return gpuSection
}

/**
 * Audio : rien n'est écrit, et c'est voulu. Les défauts de DuckStation sont déjà ceux demandés (moteur Cubeb, périphérique par défaut de Windows
 * `OutputDevice` vide, `OutputVolume` 100, pas de sourdine, latence par défaut) ; ne rien écrire garde le volume 100 % tout en laissant un réglage
 * personnel déjà présent (ex. `OutputVolume = 80`) intact.
 */

// --- Exceptions par jeu -------------------------------------------------------------------------------------------------

/**
 * Réglages propres à un jeu, indexés par numéro de série (« SCES-01438 ») : écrits dans `gamesettings/<SERIE>.ini`, qui prime sur settings.ini pour CE jeu
 * seulement. Chaque valeur est une disposition ini comme settings.ini ([GPU] ResolutionScale, PGXPDepthBuffer, WidescreenHack ; [Display] AspectRatio ;
 * [Pad1] Type ; [ControllerPorts] pour la manette…). Vide pour l'instant : seules des exceptions confirmées y ont leur place. Un fichier déjà présent
 * (créé par l'utilisateur dans DuckStation) n'est jamais modifié.
 */
export const DUCKSTATION_GAME_OVERRIDES: Record<string, Ini> = {}

// --- Numéro de série du disque ------------------------------------------------------------------------------------------

/** Normalise le chemin de démarrage de SYSTEM.CNF (« cdrom:\\SCES_014.38;1 ») en numéro de série de DuckStation (« SCES-01438 »). */
export function serialFromBoot(boot: string): string | null {
  const m = /([A-Z]{4})[_-](\d{3})\.?(\d{2})/i.exec(boot.replace(/^.*[\\/]/, ''))
  return m ? `${m[1].toUpperCase()}-${m[2]}${m[3]}` : null
}

/**
 * Numéro de série d'un disque PS1 (.cue/.bin, .iso, .img) lu dans SYSTEM.CNF (ISO 9660, voir disc.ts), sans le décompresser ni dépendre de DuckStation ; null pour
 * un autre format (.chd, .pbp, .zip…) ou un fichier illisible.
 */
export async function readPs1Serial(path: string): Promise<string | null> {
  const cnf = await readDiscRootFile(path, (n) => /^SYSTEM\.CNF/i.test(n), 2048).catch(() => null)
  const boot = cnf ? /^\s*BOOT\s*=\s*(.+)$/im.exec(cnf.data.toString('latin1')) : null
  return boot ? serialFromBoot(boot[1].trim()) : null
}

// --- Cartes mémoire ------------------------------------------------------------------------------------------------------

/**
 * Numéros de série (« SCES-01438 ») des jeux qui ont une sauvegarde sur une carte PS1 de 128 Ko : les 15 trames de répertoire (128 octets, après la trame d'en-tête)
 * portent l'état du bloc (0x51 = premier bloc d'une sauvegarde) puis, à l'octet 10, le nom du fichier « B » + région + numéro de série + suffixe du jeu.
 */
export function ps1CardSerials(card: Buffer): string[] {
  const out = new Set<string>()
  if (card.length < 128 * 16 || card.toString('latin1', 0, 2) !== 'MC') return []
  for (let i = 1; i <= 15; i++) {
    const frame = card.subarray(i * 128, (i + 1) * 128)
    if (frame[0] !== 0x51) continue
    const m = /^B[A-Z]([A-Z]{4}-\d{5})/.exec(frame.toString('latin1', 10, 30).replace(/\0.*$/s, ''))
    if (m) out.add(m[1])
  }
  return [...out]
}
