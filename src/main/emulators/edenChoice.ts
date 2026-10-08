import type { DetectedPad, RawPad } from '@shared/pads'
import { NINTENDO_VID } from '@shared/pads'
import { EDEN_MAX_PLAYERS, type EdenNintendoPad, type EdenPad } from './configure'
import { connectedNintendoPids, lastUsedPad, preferActive } from './padChoice'
import { chooseMainPad, classifyPads, type LastUsed } from './padList'
import { connectedXInputPads, type XInputPad } from './quit'

export type EdenPlayerPad = EdenPad | EdenNintendoPad

/** Ordre des autres joueurs, stable d'une partie à l'autre : XInput par emplacement, puis Switch Pro, paires de Joy-Con, Joy-Con gauches seuls, Joy-Con droits seuls. */
const ORDER: DetectedPad['kind'][] = ['xinput', 'switch-pro', 'joycon-pair', 'joycon-left', 'joycon-right']

/**
 * Les manettes des joueurs d'Eden, d'après ce qui est branché (XInput par PowerShell, Nintendo par la lecture HID toujours en cours, sans nouvelle détection) :
 * le joueur 1 est la dernière manette utilisée (sinon XInput, Switch Pro, paire de Joy-Con, Joy-Con seul : comme pour un joueur seul qui a plusieurs manettes allumées),
 * chaque autre manette prend le joueur suivant dans un ordre stable. Une paire de Joy-Con est une seule manette. Vide : clavier d'Eden pour le joueur 1.
 * `port` : rang de la manette parmi celles de même identité (deux manettes Xbox identiques, deux Switch Pro…), dans l'ordre de leurs emplacements.
 * Pure : les trois sources sont passées en paramètres (voir `chooseEdenPads` pour les vraies).
 */
export function pickEdenPads(xinput: readonly XInputPad[], nintendoPids: readonly number[], last: LastUsed | null, xinputOrder: (pads: readonly XInputPad[]) => XInputPad[] = (p) => [...p]): EdenPlayerPad[] {
  const raw: RawPad[] = [
    ...xinput.map((x): RawPad => ({ source: 'xinput', slot: x.slot, vid: x.vid, pid: x.pid })),
    ...nintendoPids.map((pid): RawPad => ({ source: 'hid', vid: NINTENDO_VID, pid, name: '', wireless: true }))
  ]
  const pads = classifyPads(raw, last).filter((p) => ORDER.includes(p.kind))
  const main = chooseMainPad(pads)
  if (!main) return []

  // Rang de chaque manette parmi les manettes de même identité : GUID XInput (constructeur, produit, version), ou type Nintendo.
  const identity = (p: DetectedPad): string => {
    if (p.kind !== 'xinput') return p.kind
    const x = xinput.find((q) => q.slot === p.slot)
    return `xinput:${x?.vid}:${x?.pid}:${x?.ver}`
  }
  const seen = new Map<string, number>()
  const ranked = [...pads].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.slot ?? 0) - (b.slot ?? 0)).map((p) => {
    const id = identity(p)
    const port = seen.get(id) ?? 0
    seen.set(id, port + 1)
    return { pad: p, port }
  })

  // Joueur 1 : la manette principale. Aucune « dernière utilisée » parmi les XInput : on garde la règle d'avant (la dernière XInput sur laquelle on a appuyé, sinon la première).
  let first = ranked.find((r) => r.pad.id === main.id)!
  if (main.kind === 'xinput' && !main.lastUsed) {
    const slot = xinputOrder(xinput)[0]?.slot
    first = ranked.find((r) => r.pad.kind === 'xinput' && r.pad.slot === slot) ?? first
  }
  const order = [first, ...ranked.filter((r) => r !== first)].slice(0, EDEN_MAX_PLAYERS)

  const out: EdenPlayerPad[] = []
  for (const { pad, port } of order) {
    if (pad.kind === 'xinput') {
      const x = xinput.find((q) => q.slot === pad.slot)
      if (x) out.push({ vid: x.vid, pid: x.pid, ver: x.ver, port })
    } else if (pad.kind === 'switch-pro' || pad.kind === 'joycon-pair' || pad.kind === 'joycon-left' || pad.kind === 'joycon-right') {
      out.push({ nintendo: pad.kind, port })
    }
  }
  return out
}

/** Le joueur 1 seul (voir `pickEdenPads`) : null s'il n'y a aucune manette (clavier d'Eden). */
export function pickEdenPad(...args: Parameters<typeof pickEdenPads>): EdenPlayerPad | null {
  const p = pickEdenPads(...args)[0]
  if (!p) return null
  // Un seul joueur : le rang parmi les manettes identiques ne compte pas (comme avant l'arrivée du multijoueur).
  return 'nintendo' in p ? { nintendo: p.nintendo } : { vid: p.vid, pid: p.pid, ver: p.ver }
}

export async function chooseEdenPads(cacheDir: string): Promise<EdenPlayerPad[]> {
  const xinput = await connectedXInputPads(cacheDir)
  return pickEdenPads(xinput, connectedNintendoPids(), lastUsedPad(), (pads) => preferActive(pads, (p) => p.slot))
}
