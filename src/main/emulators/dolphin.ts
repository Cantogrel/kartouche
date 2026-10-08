import type { Gpu, GpuTier } from './gpu'

// Réglages Dolphin qui dépendent du matériel (GPU, écran) et du jeu (GameCube/Wii, extension, mouvements). Données pures :
// configure.ts les écrit dans les fichiers .ini (fusion, jamais d'écrasement des réglages de l'utilisateur).

type IniPatch = Record<string, Record<string, string | number | boolean>>

// --- Graphismes ---------------------------------------------------------------------------------------------------------

/** Dolphin étiquette « n x » comme 360·n lignes : 2x = 720p, 3x = 1080p, 4x = 1440p, 6x = 4K (le rendu natif fait 528 lignes, mais c'est ce repère que l'on retrouve dans ses menus). */
const LINES_PER_STEP = 360

/** Plafond du multiplicateur selon le GPU : les iGPU et petites cartes gardent de la marge pour tenir la vitesse pleine. */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 2, low: 3, mid: 4, high: 6 }

/**
 * Multiplicateur de résolution interne qui correspond à l'écran (le plus proche : 3x sur 1080p, 4x sur 1440p, 6x sur 4K), jamais
 * au-delà de ce que le GPU tient.
 */
export const dolphinScale = (gpu: Gpu, displayHeight: number): number =>
  Math.max(1, Math.min(TIER_MAX_SCALE[gpu.tier], Math.round(displayHeight / LINES_PER_STEP)))

/** Anisotropie (0 = 1x … 4 = 16x) : sans risque de compatibilité, mais coûteuse sur iGPU. */
const TIER_ANISOTROPY: Record<GpuTier, number | null> = { igpu: null, low: 2, mid: 3, high: 4 }

/**
 * Vulkan si le pilote le gère, sinon OpenGL (clés vérifiées : Core/GFXBackend « Vulkan » | « OGL » ; GFX.ini Settings/InternalResolution,
 * ShaderCompilationMode 2 = ubershaders hybrides, c'est-à-dire sans saccade de compilation ; Enhancements/MaxAnisotropy).
 * Aucun hack graphique (EFB, copies XFB, etc.) : les défauts de Dolphin et ses réglages par jeu s'appliquent.
 */
export function dolphinGraphics(gpu: Gpu, displayHeight: number): { backend: string; gfx: IniPatch } {
  const settings: Record<string, string | number | boolean> = { InternalResolution: dolphinScale(gpu, displayHeight) }
  if (gpu.tier !== 'igpu') settings.ShaderCompilationMode = 2
  const gfx: IniPatch = { Settings: settings }
  const aniso = TIER_ANISOTROPY[gpu.tier]
  if (aniso !== null) gfx.Enhancements = { MaxAnisotropy: aniso }
  return { backend: gpu.vulkan ? 'Vulkan' : 'OGL', gfx }
}

// --- Manettes -----------------------------------------------------------------------------------------------------------

/**
 * Une expression Dolphin qui cite un périphérique absent est invalide EN ENTIER (clavier compris) : on ne cite donc que la
 * manette réellement branchée, ce qui impose d'écrire ces liaisons au lancement du jeu (voir `applyDolphinPad`).
 */
const pad = (device: string | null, control: string): string | null => (device ? `\`${device}:${control}\`` : null)
const kbOrPad = (kb: string, device: string | null, control: string): string => [kb, pad(device, control)].filter(Boolean).join(' | ')

/** Manette GameCube standard : clavier, et manette XInput (`XInput/<n>/Gamepad`) si `device` est donné. */
export function dolphinGcPad(device: string | null): IniPatch {
  const k = (kb: string, control: string): string => kbOrPad(kb, device, control)
  // Sans « Device », les touches non qualifiées (clavier) n'ont aucun périphérique de référence et ne répondent pas.
  const gc: Record<string, string> = {
    Device: 'DInput/0/Keyboard Mouse',
    'Buttons/A': k('`X`', 'Button A'), 'Buttons/B': k('`Z`', 'Button B'), 'Buttons/X': k('`C`', 'Button X'), 'Buttons/Y': k('`S`', 'Button Y'),
    'Buttons/Z': k('`D`', 'Shoulder R'), 'Buttons/Start': k('`RETURN`', 'Start'),
    'Main Stick/Up': k('`UP`', 'Left Y+'), 'Main Stick/Down': k('`DOWN`', 'Left Y-'), 'Main Stick/Left': k('`LEFT`', 'Left X-'), 'Main Stick/Right': k('`RIGHT`', 'Left X+'),
    'C-Stick/Up': k('`I`', 'Right Y+'), 'C-Stick/Down': k('`K`', 'Right Y-'), 'C-Stick/Left': k('`J`', 'Right X-'), 'C-Stick/Right': k('`L`', 'Right X+'),
    'Triggers/L': k('`Q`', 'Trigger L'), 'Triggers/R': k('`W`', 'Trigger R'),
    'D-Pad/Up': k('`T`', 'Pad N'), 'D-Pad/Down': k('`G`', 'Pad S'), 'D-Pad/Left': k('`F`', 'Pad W'), 'D-Pad/Right': k('`H`', 'Pad E')
  }
  // Toujours écrits (vides sans manette) pour effacer la manette citée lors d'un lancement précédent.
  gc['Triggers/L-Analog'] = pad(device, 'Trigger L') ?? ''
  gc['Triggers/R-Analog'] = pad(device, 'Trigger R') ?? ''
  gc['Rumble/Motor'] = device ? `\`${device}:Motor L\` | \`${device}:Motor R\`` : ''
  return { GCPad1: gc }
}

/**
 * Types de profil Wiimote émulée :
 * - `nunchuk` (défaut) : Wiimote + Nunchuk, pointeur au stick droit/souris, secousse sur un bouton ;
 * - `classic` : Classic Controller, pour les jeux qui le gèrent nativement et se jouent alors comme avec une manette ;
 * - `motion` : jeux construits autour du mouvement (Wii Sports…) — balayages et secousses sur touches/stick, approximatifs par
 *   nature (aucune manette XInput n'a de gyroscope) ; pointeur à la souris seulement.
 */
export type WiimoteKind = 'nunchuk' | 'classic' | 'motion'

export function dolphinWiimote(device: string | null, kind: WiimoteKind): IniPatch {
  const k = (kb: string, control: string): string => kbOrPad(kb, device, control)
  // Plusieurs commandes de manette pour une même touche (`Button B` | `Shoulder L`).
  const kp = (kb: string, ...controls: string[]): string => [kb, ...(device ? controls.map((c) => `\`${device}:${c}\``) : [])].join(' | ')
  const padOnly = (expr: string): string => (device ? expr : '')
  const wii: Record<string, string> = {
    Source: '1',
    Device: 'DInput/0/Keyboard Mouse',
    Extension: kind === 'classic' ? 'Classic' : 'Nunchuk',
    // Disposition choisie pour Super Mario Galaxy et reprise pour tous les jeux : A/B sur les positions Xbox croisées (A = bouton B ou LB,
    // B = bouton A ou RT : gâchette du fond, plus naturelle pour la détente), « - » = Start, « + » = Back, secousse (spin) = X, penché = gâchette gauche + stick gauche.
    'Buttons/A': kp('`Click 0`', 'Button B', 'Shoulder L'), 'Buttons/B': kp('`Click 1`', 'Button A', 'Trigger R'), 'Buttons/1': '`1`', 'Buttons/2': '`2`',
    // Pas de Home sur la manette (clavier seulement) : Start/Back servent à « - »/« + », le clic du stick droit au recentrage du pointeur.
    'Buttons/-': k('Q', 'Start'), 'Buttons/+': k('E', 'Back'), 'Buttons/Home': 'RETURN',
    'D-Pad/Up': k('UP', 'Pad N'), 'D-Pad/Down': k('DOWN', 'Pad S'), 'D-Pad/Left': k('LEFT', 'Pad W'), 'D-Pad/Right': k('RIGHT', 'Pad E'),
    'Shake/X': k('`Click 2`', 'Button X'), 'Shake/Y': k('`Click 2`', 'Button X'), 'Shake/Z': k('`Click 2`', 'Button X'),
    'Tilt/Forward': padOnly(`\`${device}:Trigger L\`&\`${device}:Left Y+\``), 'Tilt/Backward': padOnly(`\`${device}:Trigger L\`&\`${device}:Left Y-\``),
    'Tilt/Left': padOnly(`\`${device}:Trigger L\`&\`${device}:Left X-\``), 'Tilt/Right': padOnly(`\`${device}:Trigger L\`&\`${device}:Left X+\``),
    'Hotkeys/Upright Hold': pad(device, 'Trigger L') ?? ''
  }
  // Pointeur : stick droit en relatif (recentrage sur le clic du stick, masqué à l'arrêt) quand une manette est branchée ; sans
  // manette, souris en absolu. Le stick droit sert aux balayages dans le profil « motion », qui garde donc la souris seule.
  const stickIr = device !== null && kind !== 'motion'
  Object.assign(wii, stickIr
    ? { 'IR/Relative Input': 'True', 'IR/Auto-Hide': 'True', 'IR/Dead Zone': '15.', 'IR/Up': pad(device, 'Right Y+')!, 'IR/Down': pad(device, 'Right Y-')!, 'IR/Left': pad(device, 'Right X-')!, 'IR/Right': pad(device, 'Right X+')!, 'IR/Recenter': pad(device, 'Thumb R')! }
    : { 'IR/Relative Input': 'False', 'IR/Auto-Hide': 'False', 'IR/Up': '`Cursor Y-`', 'IR/Down': '`Cursor Y+`', 'IR/Left': '`Cursor X-`', 'IR/Right': '`Cursor X+`', 'IR/Recenter': '' })
  if (kind === 'classic') {
    // Disposition Classic Controller (A à droite, B en bas, X en haut, Y à gauche) sur les positions physiques d'une manette Xbox.
    Object.assign(wii, {
      'Classic/Buttons/A': k('`X`', 'Button B'), 'Classic/Buttons/B': k('`Z`', 'Button A'), 'Classic/Buttons/X': k('`C`', 'Button Y'), 'Classic/Buttons/Y': k('`S`', 'Button X'),
      'Classic/Buttons/ZL': k('`3`', 'Shoulder L'), 'Classic/Buttons/ZR': k('`4`', 'Shoulder R'),
      'Classic/Buttons/-': k('`BACK`', 'Back'), 'Classic/Buttons/+': k('`RETURN`', 'Start'), 'Classic/Buttons/Home': '`TAB`',
      'Classic/Triggers/L': k('`Q`', 'Trigger L'), 'Classic/Triggers/R': k('`E`', 'Trigger R'),
      'Classic/Triggers/L-Analog': pad(device, 'Trigger L') ?? '', 'Classic/Triggers/R-Analog': pad(device, 'Trigger R') ?? '',
      'Classic/D-Pad/Up': k('`UP`', 'Pad N'), 'Classic/D-Pad/Down': k('`DOWN`', 'Pad S'), 'Classic/D-Pad/Left': k('`LEFT`', 'Pad W'), 'Classic/D-Pad/Right': k('`RIGHT`', 'Pad E'),
      'Classic/Left Stick/Up': k('`W`', 'Left Y+'), 'Classic/Left Stick/Down': k('`S`', 'Left Y-'), 'Classic/Left Stick/Left': k('`A`', 'Left X-'), 'Classic/Left Stick/Right': k('`D`', 'Left X+'),
      'Classic/Right Stick/Up': k('`I`', 'Right Y+'), 'Classic/Right Stick/Down': k('`K`', 'Right Y-'), 'Classic/Right Stick/Left': k('`J`', 'Right X-'), 'Classic/Right Stick/Right': k('`L`', 'Right X+')
    })
  } else {
    Object.assign(wii, {
      'Nunchuk/Buttons/C': k('`Shift`', 'Thumb L'), 'Nunchuk/Buttons/Z': k('`Ctrl`', 'Shoulder R'),
      'Nunchuk/Stick/Up': k('W', 'Left Y+'), 'Nunchuk/Stick/Down': k('S', 'Left Y-'), 'Nunchuk/Stick/Left': k('A', 'Left X-'), 'Nunchuk/Stick/Right': k('D', 'Left X+')
    })
  }
  if (kind === 'motion') {
    Object.assign(wii, {
      'Swing/Up': kbOrPad('`I`', device, 'Right Y+'), 'Swing/Down': kbOrPad('`K`', device, 'Right Y-'),
      'Swing/Left': kbOrPad('`J`', device, 'Right X-'), 'Swing/Right': kbOrPad('`L`', device, 'Right X+'),
      'Swing/Forward': kbOrPad('`SPACE`', device, 'Shoulder R'), 'Swing/Backward': '`V`'
    })
  }
  wii['Rumble/Motor'] = device ? `\`${device}:Motor L\` | \`${device}:Motor R\`` : ''
  return { Wiimote1: wii }
}

// --- Manettes Nintendo (Switch Pro, Joy-Con) : lues par SDL (pilote HIDAPI), gyroscope compris ----------------------------

export type DolphinNintendo = 'switch-pro' | 'joycon-pair' | 'joycon-right'

/** Manette d'un joueur de Dolphin : une XInput (emplacement) ou une manette Nintendo (type et rang parmi les manettes de même type). */
export interface DolphinPlayerPad { xinputSlot: number | null; nintendo: { kind: DolphinNintendo; port: number } | null }

/** Nom du périphérique SDL dans Dolphin (`SDL/<rang parmi les manettes de même nom>/<nom>`) ; la paire de Joy-Con est UN périphérique (SDL les réunit). */
export function dolphinNintendoDevice(kind: DolphinNintendo, port = 0): string {
  const name = kind === 'switch-pro' ? 'Nintendo Switch Pro Controller' : kind === 'joycon-pair' ? 'Nintendo Switch Joy-Con (L/R)' : 'Nintendo Switch Joy-Con (R)'
  return `SDL/${port}/${name}`
}

/**
 * Réécrit une disposition faite pour une manette XInput (liaisons qualifiées par `dev`, clavier en plus) pour une manette SDL Nintendo : la manette devient le périphérique par défaut
 * (comme la paire de Joy-Con, validée en jeu), les liaisons clavier, qui n'existent pas pour elle, sont retirées et les autres s'écrivent sans qualificatif. Noms SDL par position
 * (Button S = bas, E = droite, W = gauche, N = haut) : A/B/X/Y de la XInput deviennent S/E/W/N.
 */
function sdlOnly(section: Record<string, string | number | boolean>, dev: string, face: Record<string, string> = { A: 'S', B: 'E', X: 'W', Y: 'N' }): Record<string, string | number | boolean> {
  const own = '`' + dev + ':'
  const faceRef = new RegExp(own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'Button ([ABXY])`', 'g')
  return Object.fromEntries(Object.entries(section).map(([k, v]) => {
    if (k === 'Device') return [k, dev]
    if (typeof v !== 'string' || ['Source', 'Extension', 'IR/Relative Input', 'IR/Auto-Hide', 'IR/Dead Zone'].includes(k)) return [k, v]
    const terms = v.replace(faceRef, (_m, c: string) => own + 'Button ' + face[c] + '`').split(' | ').filter((t) => t.includes(own))
    return [k, terms.join(' | ').split(own).join('`')]
  }))
}

/** Manette GameCube avec une Switch Pro ou une paire de Joy-Con (SDL réunit la paire en une manette standard) : la disposition de la XInput. Un Joy-Con seul n'a pas de quoi faire une manette GameCube. */
export function dolphinNintendoGcPad(kind: Exclude<DolphinNintendo, 'joycon-right'>, port: number): IniPatch {
  const dev = dolphinNintendoDevice(kind, port)
  // Jeu Nintendo, manette Nintendo : les boutons gardent leur place (A à droite, B en bas, X en haut, Y à gauche), contrairement à la XInput où A est en bas.
  return { GCPad1: sdlOnly(dolphinGcPad(dev).GCPad1, dev, { A: 'E', B: 'S', X: 'N', Y: 'W' }) }
}

/**
 * Wiimote émulée avec une manette Nintendo. Le pointeur vient du gyroscope (groupe « Point » de Dolphin = `IMUIR`, recentré sur R) ; ne pas
 * cocher « Point (Passthrough) » (`IRPassthrough`), c'est l'infrarouge d'une vraie Wiimote. Mouvement (accéléromètre, gyroscope) et retour
 * de force passent par la manette. Référence : le profil validé en jeu (Super Mario Galaxy) avec la paire de Joy-Con.
 */
export function dolphinNintendoWiimote(kind: DolphinNintendo, port: number, wiiKind: WiimoteKind): IniPatch {
  if (kind === 'switch-pro') {
    // Switch Pro = manette standard : exactement la disposition de la manette XInput, avec les noms SDL de Dolphin.
    const dev = dolphinNintendoDevice(kind, port)
    return { Wiimote1: sdlOnly(dolphinWiimote(dev, wiiKind).Wiimote1, dev) }
  }
  const wii: Record<string, string> = {
    Source: '1',
    Device: dolphinNintendoDevice(kind, port),
    Extension: kind === 'joycon-right' ? 'None' : wiiKind === 'classic' ? 'Classic' : 'Nunchuk',
    'IMUAccelerometer/Up': '`Accel Up`', 'IMUAccelerometer/Down': '`Accel Down`', 'IMUAccelerometer/Left': '`Accel Left`', 'IMUAccelerometer/Right': '`Accel Right`',
    'IMUAccelerometer/Forward': '`Accel Forward`', 'IMUAccelerometer/Backward': '`Accel Backward`',
    'IMUGyroscope/Pitch Up': '`Gyro Pitch Up`', 'IMUGyroscope/Pitch Down': '`Gyro Pitch Down`', 'IMUGyroscope/Roll Left': '`Gyro Roll Left`', 'IMUGyroscope/Roll Right': '`Gyro Roll Right`',
    'IMUGyroscope/Yaw Left': '`Gyro Yaw Left`', 'IMUGyroscope/Yaw Right': '`Gyro Yaw Right`',
    'Shake/X': '`Click 2`', 'Shake/Y': '`Click 2`', 'Shake/Z': '`Click 2`',
    'IMUIR/Recenter': '`Shoulder R`',
    'Rumble/Motor': '`Motor R`',
    'Buttons/A': '`Button E`', 'Buttons/B': '`Trigger R`', 'Buttons/1': '`Button N`', 'Buttons/2': '`Button W`'
  }
  const stick = { 'Nunchuk/Stick/Up': '`Left Y+`', 'Nunchuk/Stick/Down': '`Left Y-`', 'Nunchuk/Stick/Left': '`Left X-`', 'Nunchuk/Stick/Right': '`Left X+`', 'Nunchuk/Buttons/C': '`Shoulder L`', 'Nunchuk/Buttons/Z': '`Trigger L`' }
  if (kind === 'joycon-pair') {
    // Joy-Con droit = Wiimote, gauche = Nunchuk. SDL voit « - » et « + » de la paire réunie comme des palettes ; la croix de la Wiimote est sur le stick droit.
    Object.assign(wii, stick, {
      'Buttons/-': '`Paddle 1`', 'Buttons/+': '`Paddle 3`', 'Buttons/Home': 'Guide', 'Nunchuk/Stick/Dead Zone': '15.',
      'D-Pad/Up': '`Right Y+`', 'D-Pad/Down': '`Right Y-`', 'D-Pad/Left': '`Right X-`', 'D-Pad/Right': '`Right X+`'
    })
  } else {
    // Joy-Con droit seul = la Wiimote, sans Nunchuk (choix voulu : un jeu qui l'exige le réclame, comme avec une vraie Wiimote). Mapping fait à la main dans Dolphin sur le matériel :
    // SDL expose ce Joy-Con tourné d'un quart de tour (A = Button S, X = Button E, Y = Button N, R = Paddle 1, ZR = Paddle 3, SL = Shoulder L, SR = Shoulder R, stick = Left X/Y).
    // Capteurs et vibreur gardent leurs noms d'origine (le pointage au gyroscope est juste ainsi), recentrage sur R, le stick fait la croix.
    Object.assign(wii, {
      'Buttons/A': '`Button S`', 'Buttons/B': '`Paddle 3`', 'Buttons/1': '`Button E`', 'Buttons/2': '`Button N`', 'Buttons/-': '`Shoulder R`', 'Buttons/+': '`Shoulder L`', 'Buttons/Home': 'Guide',
      'D-Pad/Up': '`Left X+`', 'D-Pad/Down': '`Left X-`', 'D-Pad/Left': '`Left Y+`', 'D-Pad/Right': '`Left Y-`',
      'IMUIR/Recenter': '`Paddle 1`',
      // Capteurs : relevé SDL sur le matériel. La paire réunie est dans le repère d'une manette tenue de face (monter le bout = x+, tourner à gauche = y+, rouler à gauche = z+), noms Dolphin d'origine.
      // Le Joy-Con seul est tourné d'un quart de tour : monter le bout = z+, rouler à gauche = x-, lacet y+ : tangage et roulis (et accélérations avant/arrière et gauche/droite) sont échangés.
      'IMUGyroscope/Pitch Up': '`Gyro Roll Left`', 'IMUGyroscope/Pitch Down': '`Gyro Roll Right`', 'IMUGyroscope/Roll Left': '`Gyro Pitch Down`', 'IMUGyroscope/Roll Right': '`Gyro Pitch Up`',
      'IMUAccelerometer/Forward': '`Accel Right`', 'IMUAccelerometer/Backward': '`Accel Left`', 'IMUAccelerometer/Left': '`Accel Forward`', 'IMUAccelerometer/Right': '`Accel Backward`'
    })
  }
  return { Wiimote1: wii }
}

/** Signature du profil Nintendo de Kartouche (périphérique SDL Nintendo, A, recentrage) : tant qu'elle est là, le fichier n'a pas été retouché à la main. */
export function isKartoucheNintendoWiimote(text: string): boolean {
  // Le fichier contient aussi Wiimote2 à 4 (Device clavier) : seule la section Wiimote1 compte.
  const section = /^\[Wiimote1\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? text
  const get = (k: string): string | undefined => new RegExp(`^\\s*${k}\\s*=\\s*(.*?)\\s*$`, 'm').exec(section)?.[1]
  if (!/^SDL\/\d+\/Nintendo Switch /.test(get('Device') ?? '')) return false
  // Joy-Con : A seul + recentrage du pointeur ; Switch Pro : A ou LB (disposition de la XInput).
  return ((get('Buttons/A') === '`Button E`' && get('IMUIR/Recenter') === '`Shoulder R`') || (get('Buttons/A') === '`Button S`' && get('IMUIR/Recenter') === '`Paddle 1`')) || get('Buttons/A') === '`Button E` | `Shoulder L`'
}

/** Signature de la touche A écrite par Kartouche sur la Wiimote : tant qu'elle est là, le fichier n'a pas été retouché à la main. */
export function isUntouchedWiimoteFile(text: string): boolean {
  const a = /^\s*Buttons\/A\s*=\s*(.*?)\s*$/m.exec(text)
  return !a || /^`Click 0`(\s*\|.*)?$/.test(a[1]) || isKartoucheNintendoWiimote(text)
}

// --- Exceptions par jeu -------------------------------------------------------------------------------------------------

/**
 * Profil de manette particulier à un jeu, repéré par les 3 premiers caractères de son identifiant disque (indépendants de la
 * région). Indexé par console : un jeu GameCube ne reçoit jamais un profil Wii, ni l'inverse. Ne contient que du confirmé ; pour
 * ajouter un jeu, une ligne suffit. Pas d'entrée GameCube : la manette standard convient à tous les jeux.
 */
export const DOLPHIN_WII_PROFILES: Record<string, WiimoteKind> = {
  // Classic Controller géré nativement, plus confortable qu'une Wiimote : Super Smash Bros. Brawl, Mario Kart Wii, Xenoblade Chronicles, Monster Hunter Tri.
  RSB: 'classic', RMC: 'classic', SX4: 'classic', R3A: 'classic',
  // Jeux construits autour du mouvement : Wii Sports, Wii Sports Resort, Wii Play, Zelda Skyward Sword.
  RSP: 'motion', RZT: 'motion', RHA: 'motion', SOU: 'motion'
}

/** Profil Wiimote d'un jeu Wii (Nunchuk par défaut). */
export const wiimoteKindFor = (gameId: string | null): WiimoteKind => (gameId && DOLPHIN_WII_PROFILES[gameId.slice(0, 3).toUpperCase()]) || 'nunchuk'
