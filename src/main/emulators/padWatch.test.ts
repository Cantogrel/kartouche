import { describe, expect, it } from 'vitest'
import { parseHidLine, parseListLine } from './padWatch'

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
    expect(parseHidLine('CHORD 1')).toEqual({ type: 'chord', down: true })
    expect(parseHidLine('CHORD 0')).toEqual({ type: 'chord', down: false })
  })

  it('Nintendo : le reste est ignoré', () => {
    expect(parseHidLine('')).toBeNull()
    expect(parseHidLine('CHORD 2')).toBeNull()
    expect(parseHidLine('ACT zz')).toBeNull()
  })
})
