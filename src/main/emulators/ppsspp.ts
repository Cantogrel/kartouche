import { readDiscRootFile } from './disc'
import type { Gpu, GpuTier } from './gpu'
import { sfoString } from './rpcs3'

// Réglages PPSSPP qui dépendent du matériel et du jeu. Données pures : configure.ts les écrit dans `ppsspp.ini` (fusion, jamais d'écrasement des réglages de
// l'utilisateur). Vérifié sur PPSSPP v1.20.4 (fichiers qu'il écrit lui-même au premier lancement).
//
// Fichiers et mécanismes (mode portable : dossier `memstick/`) :
// - `memstick/PSP/SYSTEM/ppsspp.ini` : configuration globale ([General], [Graphics], [Sound], [Control]…) ;
// - `memstick/PSP/SYSTEM/<ID>_ppsspp.ini` : réglages par jeu natifs (mêmes sections, seulement les clés qui diffèrent), nommés d'après le DISC_ID de PARAM.SFO (« UCES00842 ») ;
// - `memstick/PSP/SYSTEM/controls.ini` : mapping des touches. PPSSPP le crée avec des défauts qui couvrent déjà le clavier (périphérique 1), les manettes XInput (20, dont
//   le pad virtuel de Sunshine/Moonlight, sans nom de matériel) et les manettes SDL (10) — vérifié : on n'y touche pas, donc aucune couche de remapping ;
// - PPSSPP applique lui-même des contournements par jeu depuis sa base interne (assets/compat.ini) : on n'y touche pas.

export type Ini = Record<string, Record<string, string | number | boolean>>

// --- Rendu --------------------------------------------------------------------------------------------------------------

/** Hauteur de l'image de la PSP (272 lignes) : un facteur n rend 272 n lignes. */
const PSP_HEIGHT = 272

/** Facteur maximal par niveau de GPU (PPSSPP va jusqu'à 10x). */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 2, low: 4, mid: 6, high: 10 }

/** Facteur de résolution : le plus petit qui remplit la hauteur de l'écran (4x sur 1080p, 6x sur 1440p, 8x sur 4K), borné par le GPU. */
export const ppssppScale = (gpu: Gpu, displayHeight: number): number =>
  Math.max(1, Math.min(TIER_MAX_SCALE[gpu.tier], Math.ceil((displayHeight * 0.95) / PSP_HEIGHT)))

/**
 * Section [Graphics] : Vulkan si le pilote le gère (sinon Direct3D 11, l'API la plus répandue sous Windows), sur le GPU détecté (`VulkanDevice` = son nom ; vide = choix
 * automatique de PPSSPP), résolution entière adaptée à l'écran. Le cache de shaders (`ShaderCache`), le filtrage automatique et le ratio d'origine sont les défauts de
 * PPSSPP et ne sont pas touchés ; jamais de mise à l'échelle des textures (floue), de saut d'images ni de hack global.
 */
export function ppssppGraphics(gpu: Gpu, displayHeight: number): Record<string, string | number | boolean> {
  const graphics: Record<string, string | number | boolean> = {
    FullScreen: true,
    GraphicsBackend: gpu.vulkan ? '3 (VULKAN)' : '2 (DIRECT3D11)',
    InternalResolution: ppssppScale(gpu, displayHeight)
  }
  if (gpu.vulkan && gpu.name) graphics.VulkanDevice = gpu.name
  return graphics
}

/**
 * Audio : rien n'est écrit, et c'est voulu. Les défauts de PPSSPP sont déjà ceux demandés (sortie sur le périphérique par défaut de Windows `AutoAudioDevice = True`,
 * `GameVolume = 100`, tampon par défaut) ; ne rien écrire laisse intact un réglage personnel déjà présent.
 */

// --- Manettes -----------------------------------------------------------------------------------------------------------

/**
 * `controls.ini` ne lie par défaut que la manette XInput n°0 (périphérique 20, « 20-96 » = Croix). Avec les manettes virtuelles de Sunshine, la manette utilisée est souvent
 * une autre (1 à 3) : chaque liaison `20-<touche>` reçoit donc aussi `21-`, `22-` et `23-`. Idempotent ; clavier, manettes SDL (10) et liaisons déjà présentes intacts.
 */
export function expandXInputPads(text: string): string {
  return text.replace(/^([^\r\n=]+=\s*)(.*)$/gm, (line, head: string, value: string) => {
    const tokens = value.split(',').map((t) => t.trim()).filter(Boolean)
    const add: string[] = []
    for (const t of tokens) {
      const m = /^20-(\d+)$/.exec(t)
      if (!m) continue
      for (const d of [21, 22, 23]) if (!tokens.includes(`${d}-${m[1]}`) && !add.includes(`${d}-${m[1]}`)) add.push(`${d}-${m[1]}`)
    }
    return add.length ? `${head}${[...tokens, ...add].join(',')}` : line
  })
}

// --- Exceptions par jeu -------------------------------------------------------------------------------------------------

/**
 * Réglages propres à un jeu, indexés par DISC_ID (« UCES00842 ») : écrits dans `<ID>_ppsspp.ini`, qui prime sur ppsspp.ini pour CE jeu seulement (ex. [Graphics]
 * InternalResolution, [Graphics] FrameSkip…). Vide pour l'instant : seules des exceptions confirmées y ont leur place. Un fichier déjà présent (créé par l'utilisateur
 * dans PPSSPP) n'est jamais modifié.
 */
export const PPSSPP_GAME_OVERRIDES: Record<string, Ini> = {}

// --- Identifiant du disque ----------------------------------------------------------------------------------------------

/** DISC_ID de `PSP_GAME/PARAM.SFO` d'une image ISO (voir disc.ts) ; null pour un autre format (.cso, .chd, .pbp…) ou un fichier illisible. */
export async function readPspDiscId(path: string): Promise<string | null> {
  const sfo = await readDiscRootFile(path, [(n) => n.toUpperCase() === 'PSP_GAME', (n) => /^PARAM\.SFO/i.test(n)], 256 * 1024).catch(() => null)
  const id = sfo ? sfoString(sfo.data, 'DISC_ID') : null
  return id && /^[A-Z]{4}\d{5}$/.test(id) ? id : null
}
