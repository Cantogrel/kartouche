// Profils de manette d'Eden pour les manettes Nintendo (Switch Pro, Joy-Con). Formats relevés dans le qt-config.ini qu'Eden 0.2.1 écrit lui-même quand on lui désigne la manette
// dans Contrôles (voir le vault, projects/romvault/manettes-nintendo-phase0) : rien n'est déduit du code d'Eden.
//  - Joy-Con : pilote propre à Eden (`engine:joycon`), GUID fixes (…01 gauche, …02 droit), `pad:` 1 ou 2, boutons en masques de bits. Ne passe pas par SDL.
//  - Switch Pro : SDL, pilote HIDAPI (GUID `…6803`), numérotation propre à ce pilote (pas celle d'une manette XInput).

export type EdenNintendo = 'switch-pro' | 'joycon-pair' | 'joycon-left' | 'joycon-right'

export interface EdenNintendoProfile {
  /** `player_0_type` : 0 = Pro Controller, 1 = paire de Joy-Con, 2 = Joy-Con gauche, 3 = Joy-Con droit. */
  type: number
  /** Liaisons du joueur 1 (clés `player_0_*`). */
  keys: Record<string, string>
}

/** GUID SDL de la Switch Pro vue par le pilote HIDAPI : bus, Nintendo (057E), Pro (2009), version 0, signature `h`, sous-type 03. Relevé en Bluetooth. */
export const EDEN_PRO_GUID = '030000007e0500000920000000006803'

const sdl = (rest: string): string => `engine:sdl,port:0,guid:${EDEN_PRO_GUID},${rest}`
const sdlButton = (n: number): string => sdl(`button:${n}`)
const sdlTrigger = (axis: number): string => sdl(`axis:${axis},threshold:0.500000,invert:+`)
const sdlStick = (x: number, y: number): string => sdl(`axis_x:${x},axis_y:${y},offset_x:0.000000,offset_y:0.000000,invert_x:+,invert_y:+`)
const sdlMotion = (): string => `engine:sdl,motion:0,port:0,guid:${EDEN_PRO_GUID}`

const PRO: EdenNintendoProfile = {
  type: 0,
  keys: {
    player_0_button_a: sdlButton(1), player_0_button_b: sdlButton(0), player_0_button_x: sdlButton(3), player_0_button_y: sdlButton(2),
    player_0_button_l: sdlButton(9), player_0_button_r: sdlButton(10), player_0_button_zl: sdlTrigger(4), player_0_button_zr: sdlTrigger(5),
    player_0_button_plus: sdlButton(6), player_0_button_minus: sdlButton(4), player_0_button_lstick: sdlButton(7), player_0_button_rstick: sdlButton(8),
    player_0_button_dup: sdlButton(11), player_0_button_ddown: sdlButton(12), player_0_button_dleft: sdlButton(13), player_0_button_dright: sdlButton(14),
    player_0_lstick: sdlStick(0, 1), player_0_rstick: sdlStick(2, 3),
    player_0_button_slleft: sdlButton(9), player_0_button_srleft: sdlButton(10), player_0_button_slright: sdlButton(9), player_0_button_srright: sdlButton(10),
    player_0_button_home: sdlButton(5), player_0_button_screenshot: sdlButton(15),
    player_0_motionleft: sdlMotion(), player_0_motionright: sdlMotion()
  }
}

const guid = (side: 1 | 2): string => `${'0'.repeat(31)}${side}`
/** Liaison du pilote Joy-Con d'Eden : `side` = Joy-Con (1 gauche, 2 droit), `rest` = bouton (masque), axes ou mouvement. */
const jc = (side: 1 | 2, rest: string): string => `engine:joycon,guid:${guid(side)},port:0,pad:${side},${rest}`
const jcButton = (side: 1 | 2, mask: number): string => jc(side, `button:${mask}`)

const EMPTY = '[empty]'

// Paire de Joy-Con (joueur 1 « Joycons Dual ») : gauche = croix, L, ZL, Moins, stick gauche, Capture ; droit = A B X Y, R, ZR, Plus, stick droit, Home.
const PAIR: EdenNintendoProfile = {
  type: 1,
  keys: {
    player_0_button_a: jcButton(2, 2048), player_0_button_b: jcButton(2, 1024), player_0_button_x: jcButton(2, 512), player_0_button_y: jcButton(2, 256),
    player_0_button_l: jcButton(1, 64), player_0_button_r: jcButton(2, 16384), player_0_button_zl: jcButton(1, 128), player_0_button_zr: jcButton(2, 32768),
    player_0_button_plus: jcButton(2, 131072), player_0_button_minus: jcButton(1, 65536), player_0_button_lstick: jcButton(1, 524288), player_0_button_rstick: jcButton(2, 262144),
    player_0_button_dup: jcButton(1, 2), player_0_button_ddown: jcButton(1, 1), player_0_button_dleft: jcButton(1, 8), player_0_button_dright: jcButton(1, 4),
    player_0_lstick: jc(1, 'axis_x:0,axis_y:1'), player_0_rstick: jc(2, 'axis_x:2,axis_y:3'),
    player_0_button_slleft: EMPTY, player_0_button_srleft: EMPTY, player_0_button_slright: EMPTY, player_0_button_srright: EMPTY,
    player_0_button_home: jcButton(2, 1048576), player_0_button_screenshot: jcButton(1, 2097152),
    player_0_motionleft: jc(1, 'motion:0'), player_0_motionright: jc(2, 'motion:1')
  }
}

/** Un seul Joy-Con, tenu de côté (types « Joycon gauche » 2 et « Joycon droit » 3) : tout vient du même Joy-Con. Les boutons qu'il n'a pas physiquement restent liés comme Eden le fait. */
function single(side: 1 | 2, type: number): EdenNintendoProfile {
  const b = (mask: number): string => jcButton(side, mask)
  const stick = (x: number, y: number): string => jc(side, `axis_x:${x},axis_y:${y}${side === 2 ? ',deadzone:0.150000' : ''}`)
  return {
    type,
    keys: {
      player_0_button_a: b(2048), player_0_button_b: b(1024), player_0_button_x: b(512), player_0_button_y: b(256),
      player_0_button_l: b(64), player_0_button_r: b(16384), player_0_button_zl: b(128), player_0_button_zr: b(32768),
      player_0_button_plus: b(131072), player_0_button_minus: b(65536), player_0_button_lstick: b(524288), player_0_button_rstick: b(262144),
      player_0_button_dup: b(2), player_0_button_ddown: b(1), player_0_button_dleft: b(8), player_0_button_dright: b(4),
      player_0_lstick: stick(0, 1), player_0_rstick: stick(2, 3),
      player_0_button_slleft: side === 1 ? b(32) : EMPTY, player_0_button_srleft: side === 1 ? b(16) : EMPTY,
      player_0_button_slright: side === 2 ? b(8192) : EMPTY, player_0_button_srright: side === 2 ? b(4096) : EMPTY,
      player_0_button_home: b(1048576), player_0_button_screenshot: b(2097152),
      player_0_motionleft: jc(side, 'motion:0'), player_0_motionright: jc(side, 'motion:1')
    }
  }
}

export function edenNintendoProfile(kind: EdenNintendo): EdenNintendoProfile {
  switch (kind) {
    case 'switch-pro': return PRO
    case 'joycon-pair': return PAIR
    case 'joycon-left': return single(1, 2)
    case 'joycon-right': return single(2, 3)
  }
}

/** Toutes les clés `player_0_*` qu'un profil Nintendo peut écrire : à remettre par défaut quand on change de profil. */
export const EDEN_NINTENDO_KEYS: string[] = [...new Set((['switch-pro', 'joycon-pair', 'joycon-left', 'joycon-right'] as const).flatMap((k) => Object.keys(edenNintendoProfile(k).keys)))]

/** Vrai si la liaison du bouton A est celle qu'un de nos profils Nintendo écrit (pour reconnaître nos propres réglages, par opposition à ceux de l'utilisateur). */
export function isNintendoButtonA(value: string): boolean {
  const v = value.trim().replace(/^"(.*)"$/, '$1')
  return v === PRO.keys.player_0_button_a || /^engine:joycon,guid:0{31}[12],port:0,pad:[12],button:2048$/.test(v)
}
