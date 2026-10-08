import { watchPadActivity } from './quit'
import { setNintendoChord } from './nintendoChord'
import type { LastUsed } from './padList'
import { watchNintendoHid } from './padWatch'

/**
 * Plusieurs manettes XInput peuvent être branchées en même temps : la vraie, et celles que Sunshine crée pour le flux Moonlight (une manette Xbox 360 virtuelle
 * par manette du client, qui reste là même au repos). Les émulateurs ne lisent qu'UNE manette pour le joueur 1 ; si c'est une manette au repos, le jeu ne répond à rien.
 * On retient donc la dernière manette sur laquelle quelqu'un a appuyé (Kartouche la surveille tant qu'il tourne) et on la passe en premier. Sans information,
 * l'ordre de Windows est conservé.
 */
let lastActive: number | null = null
// Des deux familles (XInput et Nintendo, lu en HID), celle sur laquelle on a appuyé en dernier : sert à désigner « la dernière manette utilisée » dans la liste des manettes.
let lastSource: 'xinput' | 'hid' | null = null
let lastHidPid: number | null = null

export const noteActivePad = (slot: number): void => { lastActive = slot; lastSource = 'xinput' }
export const noteActiveHid = (pid: number): void => { lastHidPid = pid; lastSource = 'hid' }

/** La dernière manette utilisée, toutes familles confondues ; null tant qu'aucune n'a servi. */
export function lastUsedPad(): LastUsed | null {
  if (lastSource === 'xinput' && lastActive !== null) return { source: 'xinput', slot: lastActive }
  if (lastSource === 'hid' && lastHidPid !== null) return { source: 'hid', pid: lastHidPid }
  return null
}

/** `items` (manettes branchées) avec celle de l'emplacement actif en premier, si elle est toujours branchée ; le reste dans l'ordre d'origine. */
export function preferActive<T>(items: readonly T[], slotOf: (item: T) => number, active: number | null = lastActive): T[] {
  return [...items.filter((i) => slotOf(i) === active), ...items.filter((i) => slotOf(i) !== active)]
}

/** Rang (0, 1…) de la manette `slot` parmi les manettes branchées : numéro de joystick que SDL lui donne quand seul son pilote XInput est actif (voir sdlEnv.ts). */
export const rankAmong = (slots: readonly number[], slot: number): number => Math.max(0, [...slots].sort((a, b) => a - b).indexOf(slot))

let started = false

/** Démarre la surveillance des manettes (une seule fois). Sans effet si PowerShell ne répond pas. */
export function startPadTracker(cacheDir: string): void {
  if (started) return
  started = true
  void watchPadActivity(cacheDir, noteActivePad).catch(() => { started = false })
  // Manettes Nintendo (Joy-Con, Switch Pro) : pas du XInput, lues en HID. Sans effet si aucune n'est branchée.
  void watchNintendoHid(cacheDir, (e) => { if (e.type === 'active') noteActiveHid(e.pid); else setNintendoChord(e.down) }).catch(() => {})
}
