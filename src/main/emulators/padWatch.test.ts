import { describe, expect, it } from 'vitest'
import { HID_SCRIPT, parseHidLine, parseListLine } from './padWatch'

describe('lecture HID des manettes Nintendo : manettes virtuelles', () => {
  // Une manette Nintendo virtuelle (pont Freebox Pop → PC, pilote de manette virtuelle) a un chemin Windows « hid#hidclass#… » sans « vid_057e » : le
  // script ne doit pas écarter un périphérique sur son seul chemin, mais lire son fabricant (HidD_GetAttributes), et ne pas rouvrir les autres à chaque tour.
  it('ne filtre plus sur le seul chemin Windows', () => {
    expect(HID_SCRIPT).not.toMatch(/IndexOf\("vid_057e"[^\n]*\)\s*continue;/)
    expect(HID_SCRIPT).toContain('bool named')
    expect(HID_SCRIPT).toContain('a.vid != 0x057E')
  })

  it('mémorise les périphériques qui ne sont pas Nintendo', () => {
    expect(HID_SCRIPT).toContain('ignored.Contains(path)')
    expect(HID_SCRIPT).toContain('Ignore(path, true)')
  })
})

describe('lecture des lignes des surveillances de manettes', () => {
  it('liste : manettes XInput et HID, avec accents', () => {
    const raw = parseListLine('{"xi":[{"s":0,"v":1118,"p":767}],"hid":[{"v":1406,"p":8201,"n":"Contrôleur de jeu HID","w":true},{"v":1118,"p":746,"n":"Xbox One Game Controller","w":false}]}')
    expect(raw).toEqual([
      { source: 'xinput', slot: 0, vid: 1118, pid: 767 },
      { source: 'hid', vid: 1406, pid: 8201, name: 'Contrôleur de jeu HID', wireless: true },
      { source: 'hid', vid: 1118, pid: 746, name: 'Xbox One Game Controller', wireless: false }
    ])
  })

  it('liste vide : aucune manette (et pas une erreur)', () => {
    expect(parseListLine('{"xi":[],"hid":[]}')).toEqual([])
  })

  it('liste : ligne illisible ou incomplète ignorée', () => {
    expect(parseListLine('')).toBeNull()
    expect(parseListLine('pas du json')).toBeNull()
    expect(parseListLine('{"xi":[]}')).toBeNull()
  })

  it('Nintendo : activité (PID en hexadécimal) et combinaison', () => {
    expect(parseHidLine('ACT 2009')).toEqual({ type: 'active', pid: 0x2009 })
    expect(parseHidLine('ACT 2006')).toEqual({ type: 'active', pid: 0x2006 })
    expect(parseHidLine('ACT 2009 1')).toEqual({ type: 'active', pid: 0x2009, ord: 1 })
    expect(parseHidLine('CHORD 1')).toEqual({ type: 'chord', down: true })
    expect(parseHidLine('CHORD 0')).toEqual({ type: 'chord', down: false })
  })

  it('Nintendo : le reste est ignoré', () => {
    expect(parseHidLine('')).toBeNull()
    expect(parseHidLine('CHORD 2')).toBeNull()
    expect(parseHidLine('ACT zz')).toBeNull()
  })
})
