import { NINTENDO_VID, PID_JOYCON_LEFT, PID_JOYCON_RIGHT, PID_SWITCH_PRO, type DetectedPad, type RawPad } from '@shared/pads'

/** Dernière manette utilisée, côté XInput (emplacement) ou côté Nintendo (PID du Joy-Con ou de la Pro) : celle des deux sur laquelle on a appuyé le plus récemment. */
export interface LastUsed { source: 'xinput' | 'hid'; slot?: number; pid?: number }

type Hid = Extract<RawPad, { source: 'hid' }>

/**
 * Interprète ce que le système liste : les manettes XInput (réelles ou virtuelles, comme celles de Sunshine) restent telles quelles, les Nintendo sont reconnues par leur PID
 * (Switch Pro ; Joy-Con gauche + droit = une paire ; un seul = Joy-Con seul), les autres manettes HID sont gardées sous leur nom.
 * Une manette vue à la fois en XInput et en HID (Xbox : Windows la liste par les deux voies) n'apparaît qu'une fois, côté XInput.
 */
export function classifyPads(raw: readonly RawPad[], last: LastUsed | null = null): DetectedPad[] {
  const xinput = raw.filter((r): r is Extract<RawPad, { source: 'xinput' }> => r.source === 'xinput').sort((a, b) => a.slot - b.slot)
  const out: DetectedPad[] = xinput.map((x) => ({
    id: `xinput:${x.slot}`, kind: 'xinput', name: '', slot: x.slot, wireless: false,
    lastUsed: last?.source === 'xinput' && last.slot === x.slot
  }))

  // Une manette XInput masque son double HID. XInput expose l'interface « XUSB » de la manette (045E:02FF pour une Xbox), pas son identité réelle (045E:02EA) : on apparie par
  // constructeur seul. Identité XInput illisible : tout double HID Microsoft est retiré.
  const hid = raw.filter((r): r is Hid => r.source === 'hid')
  const doubles = new Map<number, number>()
  for (const x of xinput) if (x.vid) doubles.set(x.vid, (doubles.get(x.vid) ?? 0) + 1)
  const unreadable = xinput.some((x) => !x.vid)
  const kept = hid.filter((h) => {
    const n = doubles.get(h.vid) ?? 0
    if (n > 0) { doubles.set(h.vid, n - 1); return false }
    return !(unreadable && h.vid === 0x045e)
  })

  const lefts = kept.filter((h) => h.vid === NINTENDO_VID && h.pid === PID_JOYCON_LEFT)
  const rights = kept.filter((h) => h.vid === NINTENDO_VID && h.pid === PID_JOYCON_RIGHT)
  const isUsed = (...pids: number[]): boolean => last?.source === 'hid' && last.pid !== undefined && pids.includes(last.pid)
  const pairs = Math.min(lefts.length, rights.length)
  let n = 0
  for (const h of kept) {
    if (h.vid === NINTENDO_VID && h.pid === PID_SWITCH_PRO) out.push({ id: `pro:${n++}`, kind: 'switch-pro', name: '', slot: null, wireless: h.wireless, lastUsed: isUsed(PID_SWITCH_PRO) })
  }
  for (let i = 0; i < pairs; i++) {
    out.push({ id: `pair:${i}`, kind: 'joycon-pair', name: '', slot: null, wireless: lefts[i].wireless && rights[i].wireless, lastUsed: isUsed(PID_JOYCON_LEFT, PID_JOYCON_RIGHT) })
  }
  lefts.slice(pairs).forEach((h, i) => out.push({ id: `joycon-left:${i}`, kind: 'joycon-left', name: '', slot: null, wireless: h.wireless, lastUsed: isUsed(PID_JOYCON_LEFT) && rights.length === 0 }))
  rights.slice(pairs).forEach((h, i) => out.push({ id: `joycon-right:${i}`, kind: 'joycon-right', name: '', slot: null, wireless: h.wireless, lastUsed: isUsed(PID_JOYCON_RIGHT) && lefts.length === 0 }))
  kept.filter((h) => !(h.vid === NINTENDO_VID && [PID_SWITCH_PRO, PID_JOYCON_LEFT, PID_JOYCON_RIGHT].includes(h.pid)))
    .forEach((h, i) => out.push({ id: `other:${h.vid.toString(16)}:${h.pid.toString(16)}:${i}`, kind: 'other', name: h.name, slot: null, wireless: h.wireless, lastUsed: false }))
  return out
}
