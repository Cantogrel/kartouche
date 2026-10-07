import type { Gpu, GpuTier } from './gpu'

// Réglages melonDS qui dépendent du matériel, de la manette et du jeu. Données pures : configure.ts les écrit dans `melonDS.toml`
// (fusion de clés, jamais d'écrasement du reste). Format vérifié sur melonDS 1.1 lancé à vide, qui écrit lui-même un melonDS.toml
// complet (tables `[Instance0.Window0]`, `[Instance0.Keyboard]`, `[Instance0.Joystick]`, `[3D]`…), et dans son code source
// (src/frontend/qt_sdl/Config.cpp, EmuInstanceInput.cpp).

export type TomlValues = Record<string, string | number | boolean>

// --- Rendu --------------------------------------------------------------------------------------------------------------

/** Hauteur d'UN écran DS : un facteur n le rend en 192 n lignes. */
const DS_SCREEN_HEIGHT = 192

/** Facteur maximal du rendu OpenGL par niveau de GPU (les iGPU gardent de la marge). */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 3, low: 4, mid: 8, high: 16 }

/**
 * Rendu 3D (`3D.Renderer`) : OpenGL « compute shader » (2, plus rapide et plus fidèle à haute résolution) dès que le GPU supporte Vulkan — signe d'un
 * pilote OpenGL 4.3 moderne, requis par ce renderer — sauf sur iGPU, où OpenGL classique (1) est préféré ; sans pilote moderne (GPU ancien),
 * rendu logiciel threadé (0, `3D.Soft.Threaded`, le seul réglage de threading de melonDS, sans effet avec OpenGL).
 * Le facteur (`3D.GL.ScaleFactor`, commun aux deux rendus OpenGL) est calculé pour qu'UN SEUL écran DS remplisse la hauteur du PC, parce que le
 * dimensionnement Auto met souvent un écran en grand : 6x pour 1080p (1152 lignes), 8x pour 1440p, 11x pour 4K. Quand les deux écrans sont affichés
 * ensemble, c'est du suréchantillonnage (plus net, jamais flou). Borné par le GPU (iGPU 3x, petite carte 4x, moyenne 8x) pour garder la vitesse.
 */
export function melondsRendering(gpu: Gpu, displayHeight: number): { renderer: number; scale: number } {
  const scale = Math.max(1, Math.min(TIER_MAX_SCALE[gpu.tier], Math.ceil((displayHeight * 0.95) / DS_SCREEN_HEIGHT)))
  return { renderer: !gpu.vulkan ? 0 : gpu.tier === 'igpu' ? 1 : 2, scale }
}

/**
 * Fenêtre principale (`Instance0.Window0`) : disposition Hybrid (3 : un écran en grand, les deux en petit à côté, ce qui remplit au mieux un écran 16:9), dimensionnement Auto (3 : melonDS adapte les deux écrans à la
 * fenêtre), petit espace entre les écrans, pixels nets (pas de filtre bilinéaire), pas de mise à l'échelle entière (elle laisserait des
 * bandes). Aucune taille de fenêtre n'est imposée : tout suit l'écran du PC.
 */
export const MELONDS_WINDOW: TomlValues = { ScreenLayout: 3, ScreenSizing: 3, ScreenGap: 8, ScreenFilter: false, IntegerScaling: false, ScreenRotation: 0, ScreenSwap: false }

// --- Contrôles ----------------------------------------------------------------------------------------------------------

/**
 * Touches (valeurs Qt::Key : lettres = ASCII majuscule, touches spéciales = 0x01000000 + décalage) : mêmes conventions que les autres émulateurs
 * de Kartouche (IJKL boutons, flèches croix, Retour arrière/Entrée Select/Start). La souris n'a aucun mapping : melonDS l'utilise nativement
 * pour le stylet (clic, maintien, glisser sur l'écran du bas).
 */
export const MELONDS_KEYBOARD: TomlValues = {
  A: 76, B: 75, X: 73, Y: 74, L: 81, R: 69, Select: 16777219, Start: 16777220, Up: 16777235, Down: 16777237, Left: 16777234, Right: 16777236,
  // Raccourcis : Espace échange les écrans, F2 l'écran mis en avant, F11 plein écran, P pause, Tab avance rapide.
  HK_SwapScreens: 32, HK_SwapScreenEmphasis: 16777265, HK_FullscreenToggle: 16777274, HK_Pause: 80, HK_FastForward: 16777217
}

/** Axe SDL dans une liaison melonDS : 0x10000 | (sens << 20) | (axe << 24), sens 0 positif, 1 négatif, 2 gâchette (> 0). */
const axis = (num: number, dir: 0 | 1 | 2): number => 0x10000 | (dir << 20) | (num << 24)

/**
 * Manette : melonDS lit les « joysticks » SDL bruts (pas de nom d'appareil, pas de GUID : `JoystickID` = rang du 1er joystick). Une manette
 * XInput — Xbox, ou le pad virtuel de Sunshine/Moonlight, vu par SDL comme une Xbox — expose toujours ces indices (mapping XInput de SDL, relevé sur
 * ce PC) : boutons A=0, B=1, X=2, Y=3, LB=4, RB=5, Back=6, Start=7, L3=8, R3=9 ; croix = hat 0 ; stick gauche = axes 0 (X) et 1 (Y) ; LT/RT = axes 4 et 5.
 * Encodage melonDS : une liaison est UN entier qui combine une partie bouton/croix (16 bits bas : numéro de bouton, ou hat = 0x100 | (hat << 4) |
 * direction avec 1 haut, 2 droite, 4 bas, 8 gauche) et une partie axe (voir `axis`) — les deux sont actifs, l'une ou l'autre déclenche (c'est ce
 * que l'écran de configuration de melonDS affiche : « Hat 1 up / Axis 2 - »). Un tableau TOML n'est pas lu.
 * Positions des boutons de la DS (A à droite, B en bas, X en haut, Y à gauche) = positions Xbox, d'où A↔B et X↔Y croisés. La croix DS répond à la
 * croix ET au stick gauche ; L/R de la DS répondent aux gâchettes avant (LB/RB) ET arrière (LT/RT).
 */
export const MELONDS_JOYSTICK: TomlValues = {
  A: 1, B: 0, X: 3, Y: 2, Select: 6, Start: 7,
  L: 4 | axis(4, 2), R: 5 | axis(5, 2),
  Up: 0x101 | axis(1, 1), Down: 0x104 | axis(1, 0), Left: 0x108 | axis(0, 1), Right: 0x102 | axis(0, 0),
  // Clic du stick gauche/droit : écran mis en avant / échange des écrans. Back+Start (fermeture Kartouche) n'est pas touché.
  HK_SwapScreens: 9, HK_SwapScreenEmphasis: 8
}

// --- Exceptions par jeu -------------------------------------------------------------------------------------------------

export type ScreenOverride = Partial<Record<'ScreenLayout' | 'ScreenRotation' | 'ScreenSizing' | 'ScreenGap' | 'ScreenSwap', number | boolean>>

/**
 * Disposition propre à un jeu, indexée par son code de jeu (4 caractères de l'en-tête de la ROM, offset 0x0C) : layout 0 Natural, 1 vertical,
 * 2 horizontal, 3 hybride ; rotation 0/1/2/3 = 0°/90°/180°/270° ; dimensionnement 3 = Auto. melonDS n'a qu'une configuration globale : elle est
 * appliquée avant le lancement du jeu concerné, puis la disposition d'origine est restaurée au lancement suivant d'un autre jeu (voir
 * `planMelondsGame`). Vide pour l'instant : seules des exceptions confirmées y ont leur place (une ligne par jeu).
 */
export const MELONDS_GAME_SCREENS: Record<string, ScreenOverride> = {}

export interface LayoutState { saved: ScreenOverride; applied: ScreenOverride }

const sameValue = (a: unknown, b: unknown): boolean => String(a) === String(b)

/**
 * Décide quoi écrire dans `Instance0.Window0` pour un jeu. `current` : valeurs actuelles du fichier ; `state` : exception déjà appliquée par un
 * lancement précédent. Renvoie les clés à écrire et le nouvel état (null = plus d'exception en cours). Une valeur que l'utilisateur a changée
 * depuis (≠ celle appliquée) n'est jamais restaurée.
 */
export function planMelondsGame(current: Record<string, string>, state: LayoutState | null, override: ScreenOverride | undefined): { write: ScreenOverride; state: LayoutState | null } {
  if (override) {
    const saved: ScreenOverride = { ...(state?.saved ?? {}) }
    for (const k of Object.keys(override) as (keyof ScreenOverride)[]) if (!(k in saved) && current[k] !== undefined) saved[k] = parseValue(current[k])
    return { write: override, state: { saved, applied: override } }
  }
  if (!state) return { write: {}, state: null }
  const write: ScreenOverride = {}
  for (const k of Object.keys(state.saved) as (keyof ScreenOverride)[]) if (sameValue(current[k], state.applied[k])) write[k] = state.saved[k]
  return { write, state: null }
}

const parseValue = (v: string): number | boolean => (v === 'true' ? true : v === 'false' ? false : Number(v))

/** Valeurs `clé = valeur` d'une table TOML (`[section]`), sous forme de texte. */
export function tomlSection(text: string, section: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  const head = lines.findIndex((l) => l.trim() === `[${section}]`)
  if (head < 0) return out
  for (let i = head + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(lines[i])
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Code de jeu (4 caractères, en-tête à 0x0C) d'une ROM .nds brute ; null pour un autre format ou un fichier illisible. */
export function ndsGameCode(header: Buffer): string | null {
  if (header.length < 16) return null
  const code = header.subarray(0x0c, 0x10).toString('latin1')
  return /^[A-Z0-9]{4}$/.test(code) ? code : null
}
