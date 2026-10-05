import { execFile } from 'node:child_process'
import { readDiscRootFile } from './disc'
import type { Gpu, GpuTier } from './gpu'

// Réglages RPCS3 qui dépendent du matériel, de la manette et du jeu. Données pures : configure.ts les écrit. Vérifié sur RPCS3 0.0.42-20085 lancé avec un vrai jeu
// (Red Dead Redemption, journal détaillé), dans son code source et dans son binaire.
//
// Fichiers et mécanismes :
// - `config/config.yml` : configuration globale (Video, Audio, System…). RPCS3 choisit déjà Vulkan et le GPU le plus performant, et garde par défaut le cache de shaders
//   sur disque, la compilation asynchrone (« Async Recompiler with Shader Interpreter »), l'audio Cubeb sur le périphérique Windows et un volume maître à 100 ;
// - `config/custom_configs/config_<SERIE>.yml` : configuration par jeu native (graphismes…), créée seulement pour une exception connue ;
// - `config/input_configs/global/Default.yml` : profil de manette global. **Sans ce fichier, RPCS3 n'ajoute qu'un pad clavier** (« Input configuration empty. Adding
//   default keyboard pad handler ») : aucune manette n'est jamais utilisée, quel que soit le matériel branché. C'était la cause de l'autoconfiguration manquante ;
// - `config/input_configs/<SERIE>/Default.yml` : profil de manette propre à un jeu, qui prime sur le global (vérifié : « Loading input configuration: … <SERIE>/Default.yml »).
//
// Manettes : le handler « XInput » (périphérique « XInput Pad #n », n = emplacement XInput) ne dépend d'aucun nom de matériel : il reconnaît une manette Xbox, le pad
// virtuel de Sunshine/Moonlight, et tout ce qui s'expose en XInput (Steam Input, DS4Windows…). Les manettes Sony natives ont leurs handlers (« DualShock 4 », « DualSense »).

export type Yaml = string

// --- Graphismes ---------------------------------------------------------------------------------------------------------

/** « Resolution Scale » est un pourcentage de la résolution native 720p : 150 = 1080p, 200 = 1440p, 300 = 4K. Plafonné par le GPU (iGPU 100, petite carte 150, moyenne 200). */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 100, low: 150, mid: 200, high: 300 }
export const rpcs3Scale = (gpu: Gpu, displayHeight: number): number => Math.max(100, Math.min(TIER_MAX_SCALE[gpu.tier], Math.round((displayHeight / 720) * 2) * 50))

const q = (s: string): string => JSON.stringify(s)

/**
 * `config.yml` de départ (créé une seule fois, jamais réécrit) : langue du jeu, Vulkan (OpenGL en repli) sur le GPU détecté (`Vulkan: Adapter`, comme RPCS3 l'écrit
 * lui-même), résolution adaptée à l'écran. Aucun hack ; le ratio (16:9 par défaut) et le reste ne sont pas touchés.
 */
export function rpcs3ConfigYaml(gpu: Gpu, displayHeight: number, fr: boolean): Yaml {
  const scale = rpcs3Scale(gpu, displayHeight)
  // « Resolution » (« Default Resolution » dans les réglages) : sortie annoncée au jeu. 1080p dès que l'écran et le GPU le permettent ; un jeu qui ne le gère pas retombe
  // seul sur 720p (RPCS3 le note au journal, sans effet), et « Resolution Scale » reste ce qui amène son rendu à la résolution de l'écran.
  const lines = ['Video:', `  Renderer: ${gpu.vulkan ? 'Vulkan' : 'OpenGL'}`, ...(scale >= 150 && (gpu.tier === 'mid' || gpu.tier === 'high') ? ['  Resolution: 1920x1080'] : []), `  Resolution Scale: ${scale}`]
  if (gpu.vulkan && gpu.name) lines.push('  Vulkan:', `    Adapter: ${q(gpu.name)}`)
  lines.push('System:', `  Language: ${fr ? 'French' : 'English (US)'}`)
  return lines.join('\n') + '\n'
}

// --- Manettes -----------------------------------------------------------------------------------------------------------

export type PadKind = 'xinput' | 'dualshock4' | 'dualsense'

/** Première ligne des profils écrits par Kartouche : RPCS3 réécrit le fichier (sans ce commentaire) dès que l'utilisateur modifie ses manettes ; Kartouche n'y touche alors plus. */
export const RPCS3_INPUT_MARKER = '# romvault:rpcs3-input'

/** Disposition Xbox → PlayStation positionnelle : A = Croix, B = Rond, X = Carré, Y = Triangle, gâchettes LT/RT = L2/R2, LB/RB = L1/R1, Back = Select. */
const XINPUT_MAPPING: [string, string][] = [
  ['Left Stick Left', 'LS X-'], ['Left Stick Down', 'LS Y-'], ['Left Stick Right', 'LS X+'], ['Left Stick Up', 'LS Y+'],
  ['Right Stick Left', 'RS X-'], ['Right Stick Down', 'RS Y-'], ['Right Stick Right', 'RS X+'], ['Right Stick Up', 'RS Y+'],
  ['Start', 'Start'], ['Select', 'Back'], ['PS Button', 'Guide'],
  ['Square', 'X'], ['Cross', 'A'], ['Circle', 'B'], ['Triangle', 'Y'],
  ['Left', 'Left'], ['Down', 'Down'], ['Right', 'Right'], ['Up', 'Up'],
  ['R1', 'RB'], ['R2', 'RT'], ['R3', 'RS'], ['L1', 'LB'], ['L2', 'LT'], ['L3', 'LS']
]

/**
 * Profil de manette du joueur 1. XInput : `slot` = emplacement XInput (0 à 3) de la manette connectée, écrit en « XInput Pad #<slot+1> » (RPCS3 numérote à partir de 1) ;
 * mapping Xbox explicite (celui que RPCS3 charge, relevé dans son journal). Manettes Sony : handler natif, mapping par défaut de RPCS3 pour ce handler (non testé : aucune
 * manette Sony sur la machine de développement). Les joueurs 2 à 7 restent sur « Null ».
 */
export function rpcs3InputYaml(kind: PadKind, slot = 0): Yaml {
  const head = [RPCS3_INPUT_MARKER, 'Player 1 Input:']
  if (kind === 'xinput') {
    return [...head, '  Handler: XInput', `  Device: ${q(`XInput Pad #${slot + 1}`)}`, '  Config:', ...XINPUT_MAPPING.map(([k, v]) => `    ${k}: ${v}`), '  Buddy Device: ""'].join('\n') + '\n'
  }
  return [...head, `  Handler: ${kind === 'dualsense' ? 'DualSense' : 'DualShock 4'}`, `  Device: ${q(kind === 'dualsense' ? 'DualSense Pad #1' : 'DS4 Pad #1')}`, '  Config: {}', '  Buddy Device: ""'].join('\n') + '\n'
}

/** Vrai si le profil global est absent ou encore celui de Kartouche (marqueur présent) : on peut alors le réécrire ou le retirer (retour au clavier de RPCS3). */
export const isRomvaultInput = (text: string | null): boolean => text === null || text.startsWith(RPCS3_INPUT_MARKER)

// --- Exceptions par jeu -------------------------------------------------------------------------------------------------

export interface Rpcs3GameOverride {
  /** Contenu de `config/custom_configs/config_<SERIE>.yml` (réglages graphiques ou autres propres au jeu). */
  config?: Yaml
  /** Contenu de `config/input_configs/<SERIE>/Default.yml` (manette propre au jeu). */
  input?: Yaml
}

/**
 * Réglages propres à un jeu, indexés par numéro de série (« BLES01179 ») : écrits seulement pour ce jeu, jamais par-dessus un fichier existant (créé par l'utilisateur dans
 * RPCS3). Vide pour l'instant : seules des exceptions confirmées y ont leur place.
 */
export const RPCS3_GAME_OVERRIDES: Record<string, Rpcs3GameOverride> = {}

// --- Numéro de série du jeu ---------------------------------------------------------------------------------------------

/** Valeur d'une clé texte d'un PARAM.SFO (en-tête « \0PSF », table d'index de 16 octets par entrée). */
export function sfoString(sfo: Buffer, key: string): string | null {
  if (sfo.length < 20 || sfo.readUInt32LE(0) !== 0x46535000) return null
  const keyTable = sfo.readUInt32LE(8)
  const dataTable = sfo.readUInt32LE(12)
  const count = sfo.readUInt32LE(16)
  for (let i = 0; i < count; i++) {
    const at = 20 + i * 16
    const start = keyTable + sfo.readUInt16LE(at)
    const name = sfo.subarray(start, sfo.indexOf(0, start)).toString('latin1')
    if (name !== key) continue
    const off = dataTable + sfo.readUInt32LE(at + 12)
    const raw = sfo.subarray(off, off + sfo.readUInt32LE(at + 4))
    const end = raw.indexOf(0)
    return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8')
  }
  return null
}

/** Numéro de série (« BLES01179 ») d'un jeu PS3 en image .iso, lu dans `PS3_GAME/PARAM.SFO` ; null pour un autre format (dossier, .pkg, image chiffrée…). */
export async function readPs3Serial(path: string): Promise<string | null> {
  const sfo = await readDiscRootFile(path, [(n) => n.toUpperCase() === 'PS3_GAME', (n) => /^PARAM\.SFO/i.test(n)], 256 * 1024).catch(() => null)
  const id = sfo ? sfoString(sfo.data, 'TITLE_ID') : null
  return id && /^[A-Z]{4}\d{5}$/.test(id) ? id : null
}

/**
 * Manette Sony native branchée (USB/Bluetooth) d'après les identifiants matériels Windows (VID 054C) : DualShock 4 (PID 05C4, 09CC, 0BA0) ou DualSense (0CE6, 0DF2).
 * Une manette Sony exposée en XInput (Steam Input, DS4Windows) est déjà couverte par le handler XInput. Null si rien n'est trouvé ou si la recherche échoue.
 */
export async function detectSonyPad(): Promise<PadKind | null> {
  const script = "(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_054C&PID_' }).InstanceId -join ' '"
  const ids = await new Promise<string>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 6000 }, (err, stdout) => resolve(err ? '' : stdout))
  })
  if (/PID_(0CE6|0DF2)/i.test(ids)) return 'dualsense'
  if (/PID_(05C4|09CC|0BA0)/i.test(ids)) return 'dualshock4'
  return null
}
