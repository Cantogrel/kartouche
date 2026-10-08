import { DOLPHIN_MAX_PLAYERS } from './configure'
import type { DolphinPlayerPad } from './dolphin'
import { pickEdenPads } from './edenChoice'
import { connectedNintendoPids, lastUsedPad, preferActive } from './padChoice'
import { connectedXInputPads, type XInputPad } from './quit'

/**
 * Les manettes des joueurs de Dolphin. Même règle qu'Eden (`pickEdenPads`) : le joueur 1 est la dernière manette utilisée (sinon XInput, Switch Pro, paire de Joy-Con, Joy-Con droit seul),
 * chaque autre manette prend le joueur suivant dans un ordre stable, jusqu'à quatre. Un Joy-Con gauche seul n'a pas de quoi faire une Wiimote (ni pointeur, ni boutons suffisants) :
 * il est ignoré. Pure : les sources sont passées en paramètres.
 */
export function pickDolphinPads(xinput: readonly XInputPad[], nintendoPids: readonly number[], last: Parameters<typeof pickEdenPads>[2], xinputOrder: (pads: readonly XInputPad[]) => XInputPad[]): DolphinPlayerPad[] {
  const out: DolphinPlayerPad[] = []
  for (const p of pickEdenPads(xinput, nintendoPids, last, xinputOrder)) {
    if ('nintendo' in p) {
      if (p.nintendo !== 'joycon-left') out.push({ xinputSlot: null, nintendo: { kind: p.nintendo, port: p.port ?? 0 } })
    } else {
      // Rang parmi les manettes de même identité (voir `pickEdenPads`) : l'emplacement XInput correspondant.
      const slots = xinput.filter((x) => x.vid === p.vid && x.pid === p.pid && x.ver === p.ver).map((x) => x.slot).sort((a, b) => a - b)
      const slot = slots[p.port ?? 0]
      if (slot !== undefined) out.push({ xinputSlot: slot, nintendo: null })
    }
  }
  return out.slice(0, DOLPHIN_MAX_PLAYERS)
}

/** Le joueur 1 seul (voir `pickDolphinPads`) : ni XInput ni manette Nintendo si aucune manette utilisable. */
export function pickDolphinPad(...args: Parameters<typeof pickDolphinPads>): DolphinPlayerPad {
  return pickDolphinPads(...args)[0] ?? { xinputSlot: null, nintendo: null }
}

export async function chooseDolphinPads(cacheDir: string): Promise<DolphinPlayerPad[]> {
  const xinput = await connectedXInputPads(cacheDir)
  return pickDolphinPads(xinput, connectedNintendoPids(), lastUsedPad(), (pads) => preferActive(pads, (p) => p.slot))
}
