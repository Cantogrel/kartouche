/** Manettes branchées, telles que Kartouche les interprète (liste « Manettes détectées » des Paramètres et du Big Picture). */

export type PadKind = 'xinput' | 'switch-pro' | 'joycon-left' | 'joycon-right' | 'joycon-pair' | 'other'

export interface DetectedPad {
  /** Identifiant stable pendant la vie de la manette (change si on la débranche et rebranche). */
  id: string
  kind: PadKind
  /** Nom lisible quand l'interprétation ne le dit pas assez (manette « autre »), sinon vide : l'interface utilise `kind`. */
  name: string
  /** Emplacement XInput (0 à 3) pour `xinput`, sinon null. */
  slot: number | null
  /** Sans fil (Bluetooth). */
  wireless: boolean
  /** C'est celle sur laquelle on a appuyé en dernier. */
  lastUsed: boolean
}

/** Ce que la détection système renvoie, avant interprétation. */
export type RawPad =
  | { source: 'xinput'; slot: number; vid: number; pid: number }
  | { source: 'hid'; vid: number; pid: number; name: string; wireless: boolean }

export interface PadList {
  pads: DetectedPad[]
  /** Faux si la détection système n'a pas répondu (liste alors vide, à ne pas lire comme « aucune manette »). */
  ok: boolean
}

export const NINTENDO_VID = 0x057e
export const PID_JOYCON_LEFT = 0x2006
export const PID_JOYCON_RIGHT = 0x2007
export const PID_SWITCH_PRO = 0x2009
