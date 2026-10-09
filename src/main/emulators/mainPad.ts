import type { EdenNintendo } from './edenPads'
import { pickEdenPads, type EdenPlayerPad } from './edenChoice'
import { connectedNintendoPids, lastUsedPad, preferActive } from './padChoice'
import { connectedXInputPads, type XInputPad } from './quit'

/**
 * La manette principale (joueur 1) quand c'est une manette Nintendo (Switch Pro, paire de Joy-Con, Joy-Con seul) : même règle que pour Eden et Dolphin (dernière manette utilisée,
 * sinon XInput, Switch Pro, paire, Joy-Con seul) ; null si la principale est une XInput ou s'il n'y a aucune manette. Sert aux émulateurs qui n'ont qu'un joueur 1 à configurer
 * ou dont le profil Nintendo diffère de celui de la manette Xbox. Pure : les sources sont passées en paramètres.
 */
export function pickMainNintendo(xinput: readonly XInputPad[], nintendoPids: readonly number[], last: Parameters<typeof pickEdenPads>[2], xinputOrder: (pads: readonly XInputPad[]) => XInputPad[]): EdenNintendo | null {
  const first = pickEdenPads(xinput, nintendoPids, last, xinputOrder)[0]
  return first && 'nintendo' in first ? first.nintendo : null
}

export async function chooseMainNintendo(cacheDir: string): Promise<EdenNintendo | null> {
  const xinput = await connectedXInputPads(cacheDir)
  return pickMainNintendo(xinput, connectedNintendoPids(), lastUsedPad(), (pads) => preferActive(pads, (p) => p.slot))
}

export interface SupportedMain {
  /** La manette du joueur 1 que l'émulateur sait lire (XInput, ou une manette Nintendo parmi `accepted`) : la première des manettes dans l'ordre habituel (dernière utilisée en tête). */
  pad: EdenPlayerPad | null
  /** Des manettes sont branchées mais aucune n'est lisible par cet émulateur (par exemple une paire de Joy-Con sur melonDS) : le lancement est refusé avec un message clair. */
  refused: boolean
}

/** Voir `SupportedMain`. Pure. */
export function pickSupportedMain(xinput: readonly XInputPad[], nintendoPids: readonly number[], last: Parameters<typeof pickEdenPads>[2], xinputOrder: (pads: readonly XInputPad[]) => XInputPad[], accepted: readonly EdenNintendo[]): SupportedMain {
  const all = pickEdenPads(xinput, nintendoPids, last, xinputOrder)
  const pad = all.find((p) => !('nintendo' in p) || accepted.includes(p.nintendo)) ?? null
  return { pad, refused: all.length > 0 && !pad }
}

export async function chooseSupportedMain(cacheDir: string, accepted: readonly EdenNintendo[]): Promise<SupportedMain> {
  const xinput = await connectedXInputPads(cacheDir)
  return pickSupportedMain(xinput, connectedNintendoPids(), lastUsedPad(), (pads) => preferActive(pads, (p) => p.slot), accepted)
}
