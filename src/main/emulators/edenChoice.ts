import type { RawPad } from '@shared/pads'
import { NINTENDO_VID } from '@shared/pads'
import type { EdenNintendoPad, EdenPad } from './configure'
import { connectedNintendoPids, lastUsedPad, preferActive } from './padChoice'
import { chooseMainPad, classifyPads, type LastUsed } from './padList'
import { connectedXInputPads, type XInputPad } from './quit'

/**
 * La manette qu'Eden doit lire, d'après ce qui est branché (XInput par PowerShell, Nintendo par la lecture HID toujours en cours, sans nouvelle détection) :
 * la dernière sur laquelle on a appuyé, sinon XInput (comme avant), Switch Pro, paire de Joy-Con, Joy-Con seul. Null : clavier d'Eden.
 * Pure : les trois sources sont passées en paramètres (voir `chooseEdenPad` pour les vraies).
 */
export function pickEdenPad(xinput: readonly XInputPad[], nintendoPids: readonly number[], last: LastUsed | null, xinputOrder: (pads: readonly XInputPad[]) => XInputPad[] = (p) => [...p]): EdenPad | EdenNintendoPad | null {
  const raw: RawPad[] = [
    ...xinput.map((x): RawPad => ({ source: 'xinput', slot: x.slot, vid: x.vid, pid: x.pid })),
    ...nintendoPids.map((pid): RawPad => ({ source: 'hid', vid: NINTENDO_VID, pid, name: '', wireless: true }))
  ]
  const main = chooseMainPad(classifyPads(raw, last))
  if (!main) return null
  if (main.kind === 'xinput') {
    // Aucune manette « dernière utilisée » : on garde la règle d'avant (la dernière XInput sur laquelle on a appuyé, sinon la première).
    const pad = main.lastUsed ? xinput.find((x) => x.slot === main.slot) : xinputOrder(xinput)[0]
    return pad ? { vid: pad.vid, pid: pad.pid, ver: pad.ver } : null
  }
  if (main.kind === 'switch-pro' || main.kind === 'joycon-pair' || main.kind === 'joycon-left' || main.kind === 'joycon-right') return { nintendo: main.kind }
  return null
}

export async function chooseEdenPad(cacheDir: string): Promise<EdenPad | EdenNintendoPad | null> {
  const xinput = await connectedXInputPads(cacheDir)
  return pickEdenPad(xinput, connectedNintendoPids(), lastUsedPad(), (pads) => preferActive(pads, (p) => p.slot))
}
