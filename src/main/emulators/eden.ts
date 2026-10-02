import type { Gpu, GpuTier } from './gpu'

// Réglages Eden qui dépendent du matériel et du jeu. Données pures : configure.ts les écrit (fusion, jamais d'écrasement des réglages
// de l'utilisateur). Clés, valeurs et formats vérifiés dans le code d'Eden (src/common/settings.h, settings_enums.h, frontend_common/config.cpp)
// et sur une vraie instance : lancée une fois, elle écrit un qt-config.ini complet qui confirme les noms et les défauts.

type Ini = Record<string, Record<string, string | number | boolean>>

// --- Graphismes ---------------------------------------------------------------------------------------------------------

/** Valeurs de `backend` (RendererBackend) : 0 OpenGL (GLSL), 1 Vulkan. */
export const edenBackend = (gpu: Gpu): number => (gpu.vulkan ? 1 : 0)

/**
 * Facteurs de `resolution_setup` dans l'ordre de l'énumération ResolutionSetup. Eden a inséré 1/4x et 5/4x dans cette énumération :
 * une version récente (`Res1_4X`…) et l'ancienne n'ont pas les mêmes indices, d'où les deux tables (voir `hasQuarterResolutions`).
 */
const RES_SCALES_NEW = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const RES_SCALES_OLD = [0.5, 0.75, 1, 1.5, 2, 3, 4]

/** Facteur maximal par niveau de GPU : les iGPU descendent à 0,75x pour tenir la vitesse. */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 0.75, low: 1, mid: 1.5, high: 2 }

/** Vrai si le binaire d'Eden connaît l'énumération récente (les noms `Res5_4X`… y figurent). */
export const hasQuarterResolutions = (exe: Buffer): boolean => exe.includes('Res5_4X')

/**
 * Indice de `resolution_setup` : le plus petit facteur dont le rendu en mode TV (1080p × facteur, mode par défaut d'Eden) couvre
 * l'écran à 5 % près — 1x sur 1080p, 1,5x sur 1440p, 2x sur 4K — borné par la puissance du GPU.
 */
export function edenResolution(gpu: Gpu, displayHeight: number, newEnum = true): number {
  const scales = newEnum ? RES_SCALES_NEW : RES_SCALES_OLD
  const cap = TIER_MAX_SCALE[gpu.tier]
  const fits = scales.filter((s) => s <= cap)
  const wanted = fits.find((s) => 1080 * s >= displayHeight * 0.95) ?? fits[fits.length - 1]
  return scales.indexOf(wanted)
}

// --- Contrôles ----------------------------------------------------------------------------------------------------------

/**
 * Valeurs par défaut du clavier du joueur 1 dans Eden (celles qu'il écrit lui-même), reprises pour le profil réutilisable
 * « RomVault Clavier » : le clavier garde ainsi la disposition connue d'Eden.
 */
export const EDEN_KEYBOARD_PROFILE: Record<string, string> = {
  button_a: 'engine:keyboard,code:67,toggle:0', button_b: 'engine:keyboard,code:88,toggle:0',
  button_x: 'engine:keyboard,code:86,toggle:0', button_y: 'engine:keyboard,code:90,toggle:0',
  button_lstick: 'engine:keyboard,code:70,toggle:0', button_rstick: 'engine:keyboard,code:71,toggle:0',
  button_l: 'engine:keyboard,code:81,toggle:0', button_r: 'engine:keyboard,code:69,toggle:0',
  button_zl: 'engine:keyboard,code:82,toggle:0', button_zr: 'engine:keyboard,code:84,toggle:0',
  button_plus: 'engine:keyboard,code:77,toggle:0', button_minus: 'engine:keyboard,code:78,toggle:0',
  button_dleft: 'engine:keyboard,code:16777234,toggle:0', button_dup: 'engine:keyboard,code:16777235,toggle:0',
  button_dright: 'engine:keyboard,code:16777236,toggle:0', button_ddown: 'engine:keyboard,code:16777237,toggle:0',
  lstick: 'engine:analog_from_button,up:engine$0keyboard$1code$087$1toggle$00,down:engine$0keyboard$1code$083$1toggle$00,left:engine$0keyboard$1code$065$1toggle$00,right:engine$0keyboard$1code$068$1toggle$00,modifier:engine$0keyboard$1code$016777248$1toggle$00,modifier_scale:0.500000',
  rstick: 'engine:analog_from_button,up:engine$0keyboard$1code$073$1toggle$00,down:engine$0keyboard$1code$075$1toggle$00,left:engine$0keyboard$1code$074$1toggle$00,right:engine$0keyboard$1code$076$1toggle$00,modifier:engine$0keyboard$1code$00$1toggle$00,modifier_scale:0.500000'
}

// --- Exceptions par jeu -------------------------------------------------------------------------------------------------

/**
 * Configuration propre à un jeu, indexée par son Title ID (16 chiffres hexadécimaux, majuscules) : écrite dans
 * `config/custom/<TitleID>.ini`, le fichier de configuration par jeu natif d'Eden, qui prime sur la configuration globale pour CE jeu
 * seulement. Chaque valeur est une section ini comme Eden l'écrit (réglage commutable : `clé\use_global=false` puis `clé=valeur`).
 * Aucune entrée pour l'instant : seules des exceptions confirmées (graphique ou manette) ont leur place ici. Un fichier déjà présent
 * (créé par l'utilisateur dans Eden) n'est jamais modifié.
 */
export const EDEN_GAME_OVERRIDES: Record<string, Ini> = {}
