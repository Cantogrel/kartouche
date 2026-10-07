import type { Gpu, GpuTier } from './gpu'

// Réglages Azahar qui dépendent du matériel, de la disposition d'écran et du jeu. Données pures : configure.ts les écrit dans
// `user/config/qt-config.ini` (fusion, jamais d'écrasement des réglages de l'utilisateur). Format vérifié sur Azahar 2126.1.2 lancé à vide
// (il écrit lui-même un qt-config.ini complet) et dans son code source (src/common/settings.h, citra_qt/configuration/config.cpp, hotkeys.cpp).
//
// Fichiers et mécanismes :
// - `user/config/qt-config.ini` : configuration globale ([Renderer], [Layout], [Audio], [Controls] profils, [UI] raccourcis) ;
// - `user/config/custom/<TitleID>.ini` : configuration par jeu native d'Azahar (réglages « commutables » : `clé\use_global=false` puis `clé=valeur`) ;
// - `user/nand/…/sysdata/00010017/00000000/config` : langue de la console (voir `setCfgLanguage` dans configure.ts).

export type Ini = Record<string, Record<string, string | number | boolean>>

// --- Rendu --------------------------------------------------------------------------------------------------------------

/** Valeurs de `graphics_api` (GraphicsAPI) : 0 logiciel, 1 OpenGL (défaut sous Windows), 2 Vulkan. */
export const azaharGraphicsApi = (gpu: Gpu): number => (gpu.vulkan ? 2 : 1)

/** Hauteur de l'écran du haut (400x240) : un facteur n le rend en 240 n lignes. */
const TOP_SCREEN_HEIGHT = 240

/** Facteur maximal (`resolution_factor` va de 1 à 10 dans l'interface) par niveau de GPU : les iGPU restent raisonnables. */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 2, low: 3, mid: 6, high: 10 }

/**
 * Facteur de résolution interne : le plus petit qui fait remplir la hauteur de l'écran du PC par UN écran 3DS (5x sur 1080p, 6x sur 1440p, 9x sur 4K),
 * puisque la disposition peut agrandir un seul écran ; borné par la puissance du GPU. Net et stable plutôt qu'excessif.
 */
export const azaharScale = (gpu: Gpu, displayHeight: number): number =>
  Math.max(1, Math.min(TIER_MAX_SCALE[gpu.tier], Math.ceil((displayHeight * 0.95) / TOP_SCREEN_HEIGHT)))

/**
 * Réglages graphiques globaux. Vulkan si le pilote le gère, sinon OpenGL. Shaders matériels, shader JIT et cache de shaders sur disque (déjà par
 * défaut, écrits pour rester), compilation asynchrone des shaders (moins de saccades). Aucun hack : précision des multiplications gardée,
 * pas de filtre de textures, rendu de l'œil droit conservé. `physical_device` 0 : l'ordre de Vulkan met en tête le GPU performant.
 */
export function azaharRenderer(gpu: Gpu, displayHeight: number): Record<string, string | number | boolean> {
  return {
    graphics_api: azaharGraphicsApi(gpu), physical_device: 0, resolution_factor: azaharScale(gpu, displayHeight),
    use_hw_shader: true, use_shader_jit: true, use_disk_shader_cache: true, async_shader_compilation: true
  }
}

/**
 * Disposition : « Hybrid Screen » (5) — un écran en grand et les deux écrans en petit à côté, ce qui remplit au mieux un écran 16:9 —, rien d'autre de modifié
 * (pas d'espace entre les écrans, tailles proportionnées par Azahar). Changer de disposition (F10, toutes les dispositions y compris un seul
 * écran), échanger les écrans (F9) et les pivoter (F8) sont des raccourcis natifs d'Azahar, déjà actifs.
 */
export const AZAHAR_LAYOUT: Record<string, string | number | boolean> = { layout_option: 5 }

/** Audio : moteur et périphérique « Auto » (suit le périphérique par défaut de Windows), volume 100 %, étirement actif ; ni latence ni mode exclusif forcés. */
export const AZAHAR_AUDIO: Record<string, string | number | boolean> = { output_type: 0, output_device: 'Auto', volume: 1, enable_audio_stretching: true }

// --- Exceptions par jeu -------------------------------------------------------------------------------------------------

/**
 * Configuration propre à un jeu, indexée par son Title ID (16 chiffres hexadécimaux, majuscules) : écrite dans `config/custom/<TitleID>.ini`, le
 * fichier de configuration par jeu natif d'Azahar, qui prime sur la configuration globale pour CE jeu seulement. Chaque valeur est une section ini
 * comme Azahar l'écrit pour un réglage commutable (`resolution_factor\use_global=false` puis `resolution_factor=3`). Exemples d'usage : disposition
 * (section [Layout]), résolution ([Renderer]). Vide pour l'instant : seules des exceptions confirmées y ont leur place. Un fichier déjà présent
 * (créé par l'utilisateur dans Azahar) n'est jamais modifié.
 */
export const AZAHAR_GAME_OVERRIDES: Record<string, Ini> = {}

/** Title ID (16 hex, majuscules) d'une ROM NCSD (.3ds / .cci) : identifiant de la partition 0, 8 octets little-endian à 0x108. Null pour un autre format. */
export function ncsdTitleId(header: Buffer): string | null {
  if (header.length < 0x110 || header.subarray(0x100, 0x104).toString('latin1') !== 'NCSD') return null
  return Buffer.from(header.subarray(0x108, 0x110)).reverse().toString('hex').toUpperCase()
}
