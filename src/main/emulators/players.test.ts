import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyCemuPlayers, cemuPlayerXml, cemuProfileXml } from './cemu'
import { pickSupportedPlayers } from './mainPad'
import { ANY_SDL, applyPsPlayers, rebuildPsPad } from './psPads'
import { rpcs3InputYaml } from './rpcs3'
import { assignSdl2Indexes, parseSdl2Joystick } from './sdl2Order'
import { assignSdlNumbers, parseSdlPad } from './sdlOrder'
import { prepareRetroarch } from '../saves/saves'

const PID = { left: 0x2006, right: 0x2007, pro: 0x2009 }
const order = <T,>(p: readonly T[]): T[] => [...p]
const xbox0 = { slot: 0, vid: 0x045e, pid: 0x02ff, ver: 1 }
const xbox1 = { slot: 1, vid: 0x045e, pid: 0x02ff, ver: 1 }
const ALL = ['switch-pro', 'joycon-pair'] as const

describe('une manette par joueur, selon ce que l’émulateur sait lire', () => {
  it('la dernière utilisée en premier, les autres dans l’ordre stable, les manettes illisibles sautées', () => {
    const players = pickSupportedPlayers([xbox0, xbox1], [PID.pro, PID.left, PID.right], { source: 'hid', pid: PID.pro }, order, ALL, 7)
    expect(players).toEqual([{ kind: 'switch-pro', port: 0 }, { kind: 'xinput', slot: 0, port: 0 }, { kind: 'xinput', slot: 1, port: 1 }, { kind: 'joycon-pair', port: 0 }])
    expect(pickSupportedPlayers([xbox0], [PID.pro, PID.left, PID.right], null, order, ['switch-pro'], 7).map((p) => p.kind)).toEqual(['xinput', 'switch-pro'])
    expect(pickSupportedPlayers([xbox0, xbox1], [], null, order, ALL, 1)).toHaveLength(1)
  })
})

describe('RPCS3 : un bloc par joueur', () => {
  it('joueur 2 sur sa propre manette, joueurs suivants laissés à RPCS3', () => {
    const y = rpcs3InputYaml('xinput', 0, [{ kind: 'switch-pro', slot: 0 }, { kind: 'joycon-pair', slot: 0 }])
    expect(y).toContain('Player 1 Input:\n  Handler: XInput')
    expect(y).toContain('Player 2 Input:\n  Handler: SDL\n  Device: "Nintendo Switch Pro Controller 1"')
    expect(y).toContain('Player 3 Input:\n  Handler: SDL\n  Device: "Nintendo Switch Joy-Con (L/R) 1"')
    expect(y).not.toContain('Player 4 Input')
    expect(rpcs3InputYaml('xinput', 1)).not.toContain('Player 2 Input')
  })
})

describe('Cemu : un fichier par joueur', () => {
  const mk = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cemu-'))
    mkdirSync(join(dir, 'controllerProfiles'), { recursive: true })
    return dir
  }
  it('chaque fichier ne cite que sa manette, le clavier reste au joueur 1', async () => {
    const dir = mk()
    try {
      await applyCemuPlayers(dir, [{ kind: 'switch-pro', port: 0 }, { kind: 'xinput', slot: 1 }, { kind: 'switch-pro', port: 1 }], 'pro')
      const p = (n: number): string => readFileSync(join(dir, 'controllerProfiles', `controller${n}.xml`), 'utf8')
      expect(p(0)).toContain('<api>Keyboard</api>')
      expect(p(0)).toContain('<uuid>0_0300b7e67e0500000920000000006803</uuid>')
      expect(p(0)).not.toContain('<api>XInput</api>')
      expect(p(1)).not.toContain('Keyboard')
      expect(p(1)).toMatch(/<api>XInput<\/api>\s*<uuid>1<\/uuid>/)
      expect(p(2)).toContain('<uuid>1_0300b7e67e0500000920000000006803</uuid>')
      expect(existsSync(join(dir, 'controllerProfiles', 'controller3.xml'))).toBe(false)
      // Un seul joueur ensuite : les fichiers des joueurs suivants (de Kartouche) disparaissent, celui du joueur 1 est laissé à applyCemuControls.
      await applyCemuPlayers(dir, [{ kind: 'switch-pro', port: 0 }], 'pro')
      expect(existsSync(join(dir, 'controllerProfiles', 'controller1.xml'))).toBe(false)
      expect(existsSync(join(dir, 'controllerProfiles', 'controller2.xml'))).toBe(false)
      expect(p(0)).toContain('<api>Keyboard</api>')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('un fichier retouché dans Cemu (sans le marqueur) n’est jamais touché ; le profil seul est celui d’avant', async () => {
    const dir = mk()
    try {
      writeFileSync(join(dir, 'controllerProfiles', 'controller1.xml'), '<emulated_controller>main</emulated_controller>')
      await applyCemuPlayers(dir, [{ kind: 'xinput', slot: 0 }, { kind: 'xinput', slot: 1 }], 'pro')
      expect(readFileSync(join(dir, 'controllerProfiles', 'controller1.xml'), 'utf8')).toContain('main')
      expect(cemuPlayerXml('pro', { kind: 'xinput', slot: 0 }, true)).toContain('romvault:cemu-profile=pro')
      expect(cemuProfileXml('pro')).toContain('<api>Keyboard</api>')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('DuckStation / PCSX2 : un port par joueur', () => {
  const duck = ['[Pad1]', 'Type = AnalogController', 'Cross = Keyboard/K', 'Cross = SDL-0/A', 'Cross = SDL-1/A', 'Up = Keyboard/UpArrow', 'Up = SDL-0/DPadUp', 'LargeMotor = SDL-0/LargeMotor', 'SmallMotor = SDL-0/SmallMotor', '[Other]', 'X = 1', ''].join('\n')
  it('deux joueurs : chacun lit son numéro SDL, le clavier reste au joueur 1, le port 2 est créé', () => {
    let t = rebuildPsPad(duck, 'Pad1', 'duckstation', { indexes: [2], nintendo: true, swapFace: false }, null)
    t = rebuildPsPad(t, 'Pad2', 'duckstation', { indexes: [0], nintendo: false, swapFace: false }, 'AnalogController')
    const [pad1, rest] = t.split('[Pad2]')
    expect(pad1).toMatch(/^Cross = SDL-2\/A$/m)
    expect(pad1).not.toMatch(/SDL-0|SDL-1/)
    expect(pad1).toMatch(/^Cross = Keyboard\/K$/m)
    expect(pad1).toMatch(/^LargeMotor = $/m) // manette Nintendo : sans vibration
    expect(rest).toMatch(/^Type = AnalogController$/m)
    expect(rest).toMatch(/^Cross = SDL-0\/A$/m)
    expect(rest).toMatch(/^LargeMotor = SDL-0\/LargeMotor$/m)
    expect(rest).not.toMatch(/Keyboard/)
    expect(t).toContain('[Other]\nX = 1')
  })
  it('PCSX2 : noms FaceSouth…, paire de Joy-Con sans inversion ; DuckStation : A/B échangés pour la paire', () => {
    expect(rebuildPsPad('[Pad1]\nType = DualShock2\n', 'Pad1', 'pcsx2', { indexes: [0], nintendo: false, swapFace: false }, null)).toMatch(/^Cross = SDL-0\/FaceSouth$/m)
    expect(rebuildPsPad(duck, 'Pad1', 'duckstation', { indexes: [0], nintendo: true, swapFace: true }, null)).toMatch(/^Cross = SDL-0\/B$/m)
  })
  it('retour à un seul joueur : port 2 vide, joueur 1 sur n’importe laquelle des quatre premières', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'))
    const file = join(dir, 'settings.ini')
    try {
      writeFileSync(file, duck)
      const { applyPsPlayers: apply } = await import('./psPads')
      await apply(file, 'duckstation', [{ indexes: [1], nintendo: false, swapFace: false }, { indexes: [0], nintendo: true, swapFace: false }])
      expect(readFileSync(file, 'utf8')).toContain('[Pad2]')
      await apply(file, 'duckstation', [{ indexes: ANY_SDL, nintendo: false, swapFace: false }])
      const t = readFileSync(file, 'utf8')
      expect(t.split('[Pad2]')[1]).toMatch(/^Type = None$/m)
      for (const i of ANY_SDL) expect(t.split('[Pad2]')[0]).toMatch(new RegExp(`^Cross = SDL-${i}/A$`, 'm'))
      void applyPsPlayers
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('une section retouchée par l’utilisateur n’est jamais touchée', () => {
    const custom = '[Pad1]\nType = AnalogController\nCross = XInput-0/A\n'
    expect(rebuildPsPad(custom, 'Pad1', 'duckstation', { indexes: [0], nintendo: false, swapFace: false }, null)).toBe(custom)
  })
})

describe('numéros de manettes pour SDL', () => {
  it('lit la sonde SDL3 et donne à chaque joueur le numéro (indice de joueur SDL) de SA manette', () => {
    const devices = ['PAD 0 3 1406 8201 2 Nintendo Switch Pro Controller', 'PAD 1 4 1406 8200 1 Nintendo Switch Joy-Con (L/R)', 'PAD 2 5 1118 767 0 Xbox One Controller', 'END'].map(parseSdlPad).filter((d) => d !== null)
    expect(devices).toHaveLength(3)
    expect(assignSdlNumbers([{ kind: 'xinput', slot: 0, port: 0 }, { kind: 'switch-pro', port: 0 }], devices)).toEqual([0, 2])
    expect(assignSdlNumbers([{ kind: 'joycon-pair', port: 0 }, { kind: 'joycon-pair', port: 1 }], devices)).toEqual([1, null])
  })
  it('SDL2 (RetroArch) : Nintendo par le nom, XInput = joysticks non Nintendo dans l’ordre des emplacements', () => {
    const joys = ['JOY 0 1406 8201 Nintendo Switch Pro Controller', 'JOY 1 1118 767 Xbox One Controller', 'JOY 2 1118 767 Xbox One Controller'].map(parseSdl2Joystick).filter((j) => j !== null)
    expect(assignSdl2Indexes([{ kind: 'xinput', slot: 2, port: 1 }, { kind: 'xinput', slot: 0, port: 0 }, { kind: 'switch-pro', port: 0 }], joys)).toEqual([2, 1, 0])
    expect(assignSdl2Indexes([{ kind: 'joycon-pair', port: 0 }], joys)).toEqual([null])
  })
})

describe('RetroArch à plusieurs joueurs', () => {
  it('pilote commun et un rang par joueur ; le pilote d’un utilisateur reste', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-'))
    const saves = mkdtempSync(join(tmpdir(), 'saves-'))
    const cfg = join(dir, 'retroarch.cfg')
    try {
      writeFileSync(cfg, 'input_joypad_driver = "xinput"\n')
      await prepareRetroarch(dir, saves, null, null, { driver: 'sdl2', indexes: [2, 0] })
      const t = readFileSync(cfg, 'utf8')
      expect(t).toMatch(/input_joypad_driver = "sdl2"/)
      expect(t).toMatch(/input_player1_joypad_index = "2"/)
      expect(t).toMatch(/input_player2_joypad_index = "0"/)
      expect(t).toMatch(/input_player2_analog_dpad_mode = "1"/) // le stick gauche fait aussi la croix pour les joueurs suivants
      writeFileSync(cfg, 'input_joypad_driver = "dinput"\n')
      await prepareRetroarch(dir, saves, null, null, { driver: 'sdl2', indexes: [1, 0] })
      expect(readFileSync(cfg, 'utf8')).toMatch(/input_joypad_driver = "dinput"/)
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(saves, { recursive: true, force: true }) }
  })
})
