import type { DolphinNintendo } from './dolphin'
import { pickEdenPads } from './edenChoice'
import { connectedNintendoPids, lastUsedPad, preferActive } from './padChoice'
import { connectedXInputPads, type XInputPad } from './quit'

export interface DolphinPadChoice {
  /** Emplacement XInput du joueur 1 (null : pas de XInput, ou manette Nintendo choisie). */
  xinputSlot: number | null
  /** Manette Nintendo du joueur 1, si c'est elle la manette principale (dernière utilisée, sinon XInput > Switch Pro > paire > Joy-Con seul). */
  nintendo: { kind: DolphinNintendo; port: number } | null
}

/**
 * La manette du joueur 1 de Dolphin. Même règle que pour Eden (`pickEdenPads`) : dernière manette utilisée, sinon XInput, Switch Pro, paire de Joy-Con, Joy-Con droit seul.
 * Un Joy-Con gauche seul n'a pas de quoi faire une Wiimote (ni pointeur, ni boutons suffisants) : il est ignoré, et Dolphin garde le clavier ou la XInput branchée.
 * Pure : les sources sont passées en paramètres.
 */
export function pickDolphinPad(xinput: readonly XInputPad[], nintendoPids: readonly number[], last: Parameters<typeof pickEdenPads>[2], xinputOrder: (pads: readonly XInputPad[]) => XInputPad[]): DolphinPadChoice {
  // Les Joy-Con gauches seuls ne comptent pas : on les retire avant de choisir, pour qu'une XInput branchée à côté garde la main.
  const players = pickEdenPads(xinput, nintendoPids, last, xinputOrder)
  const supported = players.find((p) => !('nintendo' in p) || p.nintendo !== 'joycon-left')
  if (supported && 'nintendo' in supported && supported.nintendo !== 'joycon-left') return { xinputSlot: null, nintendo: { kind: supported.nintendo, port: supported.port ?? 0 } }
  const slot = xinputOrder(xinput)[0]?.slot ?? null
  return { xinputSlot: slot, nintendo: null }
}

export async function chooseDolphinPad(cacheDir: string): Promise<DolphinPadChoice> {
  const xinput = await connectedXInputPads(cacheDir)
  return pickDolphinPad(xinput, connectedNintendoPids(), lastUsedPad(), (pads) => preferActive(pads, (p) => p.slot))
}
