import type { Gpu, GpuTier } from './gpu'

// Réglages RetroArch qui dépendent du GPU et du cœur. Données pures : configure.ts les écrit (fusion, jamais d'écrasement des réglages
// de l'utilisateur). Vérifié sur RetroArch 1.22.2 en lançant de vrais cœurs avec le journal détaillé :
// - le dossier de configuration (`rgui_config_directory`) vaut `<exe>/config` ; un override de cœur y est lu depuis
//   `config/<corename>/<corename>.cfg` (log « Core-specific overrides found ») et les options du cœur depuis `<corename>.opt` ;
// - `global_core_options = false` par défaut : un fichier global `retroarch-core-options.cfg` n'est PAS lu ;
// - un cœur à rendu matériel OpenGL (Mupen64Plus-Next) force le pilote GL même si Vulkan est demandé (« HW render, OpenGL driver forced ») ;
// - les manettes viennent des profils officiels du dossier `autoconfig` (xinput, sdl2, dinput), reconnus à chaud ; RetroPad est positionnel
//   (bouton du bas = B, de droite = A, comme sur une console Nintendo), donc aucun remappage par système n'est nécessaire.

export type Cfg = Record<string, string | number | boolean>

/** Vulkan si le pilote le gère, sinon OpenGL (« gl », le plus compatible). Les shaders sont coupés : aucun effet lourd par défaut. */
export const retroarchVideo = (gpu: Gpu): Cfg => ({ video_driver: gpu.vulkan ? 'vulkan' : 'gl', video_shader_enable: false })

/**
 * Audio : WASAPI en mode partagé (jamais exclusif) sur le périphérique par défaut de Windows (`audio_device` vide), volume plein
 * (0 dB), son actif. Latence et synchronisation laissées aux défauts de RetroArch.
 */
export const retroarchAudio: Cfg = { audio_driver: 'wasapi', audio_device: '', audio_enable: true, audio_mute_enable: false, audio_volume: '0.000000', audio_wasapi_exclusive_mode: false }

/** Plafond du facteur de résolution native N64 par niveau de GPU (la résolution suit l'écran, voir `n64Factor`). */
const N64_MAX_FACTOR: Record<GpuTier, number> = { igpu: 2, low: 3, mid: 6, high: 8 }

/** Facteur de résolution native du cœur N64 (320x240 × n) : 4 sur 1080p, 6 sur 1440p, 8 sur 4K, borné par le GPU. */
export const n64Factor = (gpu: Gpu, displayTier: 1 | 2 | 3): number => Math.min(N64_MAX_FACTOR[gpu.tier], [4, 6, 8][displayTier - 1])

export interface RetroarchCoreConfig {
  /** `corename` du cœur (fichier `info/<id>_libretro.info`) : nom des dossier et fichiers de configuration du cœur. */
  name: string
  /** Réglages RetroArch propres à ce cœur (`config/<name>/<name>.cfg`), appliqués par-dessus ceux de `retroarch.cfg`. */
  override?: (gpu: Gpu) => Cfg
  /** Options du cœur (`config/<name>/<name>.opt`). */
  options?: (gpu: Gpu, displayTier: 1 | 2 | 3) => Cfg
}

/**
 * Configuration par cœur (indexée par identifiant libretro, voir `RETROARCH_CORES`). Un cœur absent n'a besoin d'aucun réglage propre :
 * ses défauts et ceux de RetroArch conviennent. Pour ajouter un cœur ou un système, une entrée suffit.
 */
export const RETROARCH_CORE_CONFIG: Record<string, RetroarchCoreConfig> = {
  mupen64plus_next: {
    name: 'Mupen64Plus-Next',
    // Rendu matériel GL (GLideN64) : le pilote GL est choisi d'emblée plutôt que de laisser RetroArch relancer sa vidéo après coup.
    override: (gpu) => ({ video_driver: gpu.vulkan ? 'glcore' : 'gl' }),
    options: (gpu, tier) => ({ 'mupen64plus-next-EnableNativeResFactor': n64Factor(gpu, tier) })
  }
}
