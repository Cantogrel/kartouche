import { describe, expect, it } from 'vitest'
import { isUntouchedPadFile } from './configure'
import { dolphinNintendoGcPad, dolphinNintendoWiimote, dolphinWiimote, isKartoucheNintendoWiimote, isUntouchedWiimoteFile } from './dolphin'
import { pickDolphinPad } from './dolphinChoice'

describe('manette GameCube avec une manette Nintendo', () => {
  it('Switch Pro et paire : la disposition de la XInput, la manette en périphérique par défaut', () => {
    for (const kind of ['switch-pro', 'joycon-pair'] as const) {
      const g = dolphinNintendoGcPad(kind, 0).GCPad1
      expect(g.Device).toMatch(/^SDL\/0\/Nintendo Switch /)
      expect(g['Buttons/A']).toBe('`Button E`')
      expect(g['Buttons/B']).toBe('`Button S`')
      expect(g['Buttons/X']).toBe('`Button N`')
      expect(g['Buttons/Y']).toBe('`Button W`')
      expect(g['Buttons/Start']).toBe('`Start`')
      expect(g['Main Stick/Up']).toBe('`Left Y+`')
      expect(g['Triggers/L-Analog']).toBe('`Trigger L`')
      expect(Object.entries(g).some(([k, v]) => k !== 'Device' && String(v).includes('SDL/'))).toBe(false)
      const body = Object.entries(g).map(([k, v]) => `${k} = ${v}`)
      expect(isUntouchedPadFile(['[GCPad1]', ...body, ''].join('\n'))).toBe(true)
    }
  })
})

const PID = { left: 0x2006, right: 0x2007, pro: 0x2009 }
const order = <T,>(p: readonly T[]): T[] => [...p]
const xbox = { slot: 0, vid: 0x045e, pid: 0x02ff, ver: 1 }

describe('Wiimote avec une manette Nintendo', () => {
  it('paire de Joy-Con : le profil validé en jeu (Super Mario Galaxy), clé par clé', () => {
    const w = dolphinNintendoWiimote('joycon-pair', 0, 'nunchuk').Wiimote1
    expect(w).toMatchObject({
      Device: 'SDL/0/Nintendo Switch Joy-Con (L/R)', Extension: 'Nunchuk',
      'Buttons/A': '`Button E`', 'Buttons/B': '`Trigger R`', 'Buttons/1': '`Button N`', 'Buttons/2': '`Button W`', 'Buttons/-': '`Paddle 1`', 'Buttons/+': '`Paddle 3`',
      'D-Pad/Up': '`Right Y+`', 'Nunchuk/Buttons/C': '`Shoulder L`', 'Nunchuk/Buttons/Z': '`Trigger L`', 'Nunchuk/Stick/Up': '`Left Y+`',
      'IMUIR/Recenter': '`Shoulder R`', 'Rumble/Motor': '`Motor R`', 'Nunchuk/Stick/Dead Zone': '15.', 'IMUGyroscope/Yaw Left': '`Gyro Yaw Left`', 'IMUAccelerometer/Forward': '`Accel Forward`'
    })
    // Le pointeur passe par le gyroscope, jamais par l'infrarouge d'une vraie Wiimote.
    expect(Object.keys(w).some((k) => k.startsWith('IRPassthrough'))).toBe(false)
  })

  it('Switch Pro : la disposition de la manette XInput, avec les noms SDL', () => {
    const w = dolphinNintendoWiimote('switch-pro', 1, 'nunchuk').Wiimote1
    const dev = 'SDL/1/Nintendo Switch Pro Controller'
    const x = dolphinWiimote('XInput/0/Gamepad', 'nunchuk').Wiimote1
    // Même Wiimote que la XInput : clavier gardé, A = bouton B (droite) ou LB, B = bouton A (bas) ou RB.
    // La manette est le périphérique par défaut (comme la paire de Joy-Con, validée en jeu) : plus de clavier, liaisons sans qualificatif.
    expect(w.Device).toBe(dev)
    expect(w['Buttons/A']).toBe('`Button E` | `Shoulder L`')
    expect(w['Buttons/B']).toBe('`Button S` | `Trigger R`')
    expect(w['Nunchuk/Buttons/Z']).toBe('`Shoulder R`')
    expect(w['IR/Dead Zone']).toBe('15.')
    expect(w['Shake/X']).toBe('`Button W`')
    expect(w['D-Pad/Up']).toBe('`Pad N`')
    expect(w['Tilt/Forward']).toBe('`Trigger L`&`Left Y+`')
    expect(Object.keys(w).sort()).toEqual(Object.keys(x).sort())
    expect(Object.entries(w).some(([k, v]) => k !== 'Device' && String(v).includes(dev))).toBe(false)
    expect(w['Buttons/1']).toBe('')
    expect(isUntouchedWiimoteFile(Object.entries(w).map(([k, v]) => `${k} = ${v}`).join('\n'))).toBe(true)
  })

  it('Joy-Con droit seul : Wiimote seule (sans Nunchuk), stick en croix, relevé sur le matériel', () => {
    const w = dolphinNintendoWiimote('joycon-right', 0, 'nunchuk').Wiimote1
    expect(Object.keys(w).some((k) => k.startsWith('Nunchuk/'))).toBe(false)
    expect(w.Device).toBe('SDL/0/Nintendo Switch Joy-Con (R)')
    expect(w['Buttons/A']).toBe('`Button S`')
    expect(w['D-Pad/Up']).toBe('`Left X+`')
    expect(w['Buttons/B']).toBe('`Paddle 3`')
    expect(w['Rumble/Motor']).toBe('`Motor R`')
    expect(w['IMUIR/Recenter']).toBe('`Paddle 1`')
    expect(w['IMUGyroscope/Pitch Up']).toBe('`Gyro Roll Left`')
    expect(w['IMUGyroscope/Yaw Left']).toBe('`Gyro Yaw Left`')
    const body = Object.entries(w).map(([k, v]) => `${k} = ${v}`)
    const file = ['[Wiimote2]', 'Device = DInput/0/Keyboard Mouse', '[Wiimote1]', ...body, ''].join('\n')
    expect(isUntouchedWiimoteFile(file)).toBe(true)
  })

  it('jeu en Classic Controller : extension Classic sur Pro et paire', () => {
    expect(dolphinNintendoWiimote('switch-pro', 0, 'classic').Wiimote1.Extension).toBe('Classic')
  })

  it('le fichier réel de Dolphin (Wiimote2 à 4 avant Wiimote1) : le profil de Kartouche reste reconnu, donc réécrit au lancement suivant', () => {
    const body = (kind: 'joycon-pair' | 'switch-pro'): string => Object.entries(dolphinNintendoWiimote(kind, 0, 'nunchuk').Wiimote1).map(([k, v]) => `${k} = ${v}`).join('\n')
    for (const kind of ['joycon-pair', 'switch-pro'] as const) {
      const file = `[Wiimote2]\nDevice = DInput/0/Keyboard Mouse\n[Wiimote3]\nDevice = DInput/0/Keyboard Mouse\n[Wiimote1]\n${body(kind)}\n[BalanceBoard]\nDevice = DInput/0/Keyboard Mouse\n`
      expect(isUntouchedWiimoteFile(file)).toBe(true)
    }
  })

  it('un profil Kartouche Nintendo est réécrit ; un profil modifié à la main ne l\'est pas', () => {
    const text = Object.entries(dolphinNintendoWiimote('joycon-pair', 0, 'nunchuk').Wiimote1).map(([k, v]) => `${k} = ${v}`).join('\n')
    expect(isKartoucheNintendoWiimote(text)).toBe(true)
    expect(isUntouchedWiimoteFile(text)).toBe(true)
    expect(isUntouchedWiimoteFile(text.replace('Buttons/A = `Button E`', 'Buttons/A = `Button N`'))).toBe(false)
  })
})

describe('manette de Dolphin (joueur 1)', () => {
  it('XInput seule : inchangé', () => {
    expect(pickDolphinPad([xbox], [], null, order)).toEqual({ xinputSlot: 0, nintendo: null })
  })
  it('XInput + Nintendo sans dernière utilisée : la XInput garde la main', () => {
    expect(pickDolphinPad([xbox], [PID.pro], null, order)).toEqual({ xinputSlot: 0, nintendo: null })
  })
  it('Switch Pro seule', () => {
    expect(pickDolphinPad([], [PID.pro], null, order)).toEqual({ xinputSlot: null, nintendo: { kind: 'switch-pro', port: 0 } })
  })
  it('paire de Joy-Con', () => {
    expect(pickDolphinPad([], [PID.left, PID.right], null, order).nintendo?.kind).toBe('joycon-pair')
  })
  it('Joy-Con droit seul', () => {
    expect(pickDolphinPad([], [PID.right], null, order).nintendo?.kind).toBe('joycon-right')
  })
  it('Joy-Con gauche seul : ignoré', () => {
    expect(pickDolphinPad([], [PID.left], null, order)).toEqual({ xinputSlot: null, nintendo: null })
  })
  it('rien : clavier', () => {
    expect(pickDolphinPad([], [], null, order)).toEqual({ xinputSlot: null, nintendo: null })
  })
})
