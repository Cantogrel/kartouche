import { describe, expect, it } from 'vitest'
import type { RawPad } from '@shared/pads'
import { chooseMainPad, classifyPads } from './padList'

// XInput expose l'interface XUSB (045E:02FF), RawGameController l'identité réelle de la manette (045E:02EA) : relevé sur une Xbox One.
const xbox = (slot: number): RawPad => ({ source: 'xinput', slot, vid: 0x045e, pid: 0x02ff })
const hid = (vid: number, pid: number, name = 'Contrôleur de jeu HID', wireless = true): RawPad => ({ source: 'hid', vid, pid, name, wireless })
const left = hid(0x057e, 0x2006)
const right = hid(0x057e, 0x2007)
const pro = hid(0x057e, 0x2009)

const kinds = (raw: RawPad[]): string[] => classifyPads(raw).map((p) => p.kind)

describe('liste des manettes', () => {
  it('rien de branché : liste vide', () => {
    expect(classifyPads([])).toEqual([])
  })

  it('une manette XInput reste une manette XInput, avec son emplacement', () => {
    expect(classifyPads([xbox(2)])).toMatchObject([{ kind: 'xinput', slot: 2, wireless: false }])
  })

  it('une Xbox listée par XInput ET par HID n\'apparaît qu\'une fois', () => {
    expect(kinds([xbox(0), hid(0x045e, 0x02ea, 'Xbox One Game Controller', false)])).toEqual(['xinput'])
  })

  it('deux Xbox identiques : chacune son double HID retiré, pas plus', () => {
    expect(kinds([xbox(0), xbox(1), hid(0x045e, 0x02ea), hid(0x045e, 0x02ea)])).toEqual(['xinput', 'xinput'])
    expect(kinds([xbox(0), hid(0x045e, 0x02ea), hid(0x045e, 0x02ea)])).toEqual(['xinput', 'other'])
  })

  it('identité XInput illisible : le double HID Microsoft est quand même retiré', () => {
    expect(kinds([{ source: 'xinput', slot: 0, vid: 0, pid: 0 }, hid(0x045e, 0x02ea)])).toEqual(['xinput'])
  })

  it('Switch Pro', () => {
    expect(classifyPads([pro])).toMatchObject([{ kind: 'switch-pro', wireless: true, slot: null }])
  })

  it('un seul Joy-Con : gauche seul ou droit seul', () => {
    expect(kinds([left])).toEqual(['joycon-left'])
    expect(kinds([right])).toEqual(['joycon-right'])
  })

  it('Joy-Con gauche + droit : une seule manette, la paire', () => {
    expect(kinds([left, right])).toEqual(['joycon-pair'])
    expect(kinds([right, left])).toEqual(['joycon-pair'])
  })

  it('deux gauches et un droit : une paire et un gauche seul', () => {
    expect(kinds([left, left, right])).toEqual(['joycon-pair', 'joycon-left'])
  })

  it('une Xbox et des Nintendo se côtoient sans se confondre', () => {
    expect(kinds([xbox(0), pro, left, right, hid(0x045e, 0x02ea)])).toEqual(['xinput', 'switch-pro', 'joycon-pair'])
  })

  it('une manette HID inconnue garde son nom', () => {
    expect(classifyPads([hid(0x054c, 0x0ce6, 'Wireless Controller')])).toMatchObject([{ kind: 'other', name: 'Wireless Controller' }])
  })

  it('dernière manette utilisée : XInput par emplacement, Nintendo par PID', () => {
    const raw = [xbox(0), xbox(1), pro, left, right]
    expect(classifyPads(raw, { source: 'xinput', slot: 1 }).filter((p) => p.lastUsed).map((p) => p.id)).toEqual(['xinput:1'])
    expect(classifyPads(raw, { source: 'hid', pid: 0x2009 }).filter((p) => p.lastUsed).map((p) => p.kind)).toEqual(['switch-pro'])
    expect(classifyPads(raw, { source: 'hid', pid: 0x2007 }).filter((p) => p.lastUsed).map((p) => p.kind)).toEqual(['joycon-pair'])
  })

  it('personne n\'est « dernière utilisée » sans information', () => {
    expect(classifyPads([xbox(0), pro]).some((p) => p.lastUsed)).toBe(false)
  })

  it('un Joy-Con seul est « utilisé » seulement si c\'est bien lui qui a répondu', () => {
    expect(classifyPads([left], { source: 'hid', pid: 0x2006 })[0].lastUsed).toBe(true)
    expect(classifyPads([left], { source: 'hid', pid: 0x2007 })[0].lastUsed).toBe(false)
  })
})

describe('manette à lire en priorité', () => {
  const pick = (raw: RawPad[], last = null as Parameters<typeof classifyPads>[1]): string | undefined => chooseMainPad(classifyPads(raw, last))?.kind

  it('rien de branché : clavier', () => {
    expect(pick([])).toBeUndefined()
  })

  it("sans information, XInput d'abord (comportement d'avant), puis Pro, paire, Joy-Con seul", () => {
    expect(pick([pro, xbox(0)])).toBe('xinput')
    expect(pick([left, right, pro])).toBe('switch-pro')
    expect(pick([left, right])).toBe('joycon-pair')
    expect(pick([left])).toBe('joycon-left')
    expect(pick([right])).toBe('joycon-right')
  })

  it('la dernière manette utilisée passe devant, quelle que soit sa famille', () => {
    expect(pick([xbox(0), pro], { source: 'hid', pid: 0x2009 })).toBe('switch-pro')
    expect(pick([xbox(0), pro], { source: 'xinput', slot: 0 })).toBe('xinput')
    expect(pick([xbox(0), left, right], { source: 'hid', pid: 0x2007 })).toBe('joycon-pair')
  })

  it("une dernière utilisée qui n'est plus branchée est ignorée", () => {
    expect(pick([xbox(0)], { source: 'hid', pid: 0x2009 })).toBe('xinput')
  })

  it("une manette HID inconnue n'est jamais choisie", () => {
    expect(pick([hid(0x054c, 0x0ce6, 'Wireless Controller')])).toBeUndefined()
  })
})
