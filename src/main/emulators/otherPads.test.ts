import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyMelondsPad, setTomlKeys } from './configure'
import { MELONDS_JOYSTICK, MELONDS_JOYSTICK_NINTENDO } from './melonds'
import { pickSupportedMain } from './mainPad'
import { emulatorEnv } from './sdlEnv'
import { prepareRetroarch } from '../saves/saves'

const PID = { left: 0x2006, right: 0x2007, pro: 0x2009 }
const order = <T,>(p: readonly T[]): T[] => [...p]
const xbox = { slot: 0, vid: 0x045e, pid: 0x02ff, ver: 1 }

describe('manette lisible par un émulateur', () => {
  it('XInput : toujours acceptée ; Switch Pro seulement si l’émulateur la lit', () => {
    expect(pickSupportedMain([xbox], [], null, order, [])).toMatchObject({ refused: false })
    expect(pickSupportedMain([], [PID.pro], null, order, ['switch-pro']).pad).toEqual({ nintendo: 'switch-pro', port: 0 })
    expect(pickSupportedMain([], [PID.pro], null, order, [])).toEqual({ pad: null, refused: true })
  })
  it('une paire de Joy-Con refusée, mais la Xbox branchée à côté prend le relais (pas de refus)', () => {
    expect(pickSupportedMain([], [PID.left, PID.right], null, order, ['switch-pro'])).toEqual({ pad: null, refused: true })
    const r = pickSupportedMain([xbox], [PID.left, PID.right], { source: 'hid', pid: PID.left }, order, ['switch-pro'])
    expect(r.refused).toBe(false)
    expect(r.pad).toMatchObject({ vid: 0x045e })
  })
  it('aucune manette : rien à refuser', () => {
    expect(pickSupportedMain([], [], null, order, [])).toEqual({ pad: null, refused: false })
  })
})

describe('melonDS avec une Switch Pro', () => {
  const dirWith = (joystick: Record<string, string | number | boolean>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'melon-'))
    writeFileSync(join(dir, 'melonDS.toml'), setTomlKeys(setTomlKeys('[Instance0]\nJoystickID = 0\n', 'Instance0', {}), 'Instance0.Joystick', joystick))
    return dir
  }
  it('bascule les liaisons selon le type de manette tant qu’elles sont celles de Kartouche', async () => {
    const dir = dirWith(MELONDS_JOYSTICK)
    try {
      await applyMelondsPad(dir, 0, true)
      let text = readFileSync(join(dir, 'melonDS.toml'), 'utf8')
      expect(text).toMatch(/^A = 0$/m) // pas de croisement A/B : SDL2 nomme d'après l'étiquette
      await applyMelondsPad(dir, 2, false)
      text = readFileSync(join(dir, 'melonDS.toml'), 'utf8')
      expect(text).toMatch(/^A = 1$/m)
      expect(text).toMatch(/^JoystickID = 2$/m)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('des liaisons refaites dans melonDS ne sont jamais touchées', async () => {
    const dir = dirWith({ ...MELONDS_JOYSTICK, A: 5 })
    try {
      await applyMelondsPad(dir, 0, true)
      expect(readFileSync(join(dir, 'melonDS.toml'), 'utf8')).toMatch(/^A = 5$/m)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('les liaisons Nintendo suivent le relevé de la Pro (croix en boutons 11 à 14, ZL/ZR en axes)', () => {
    expect(MELONDS_JOYSTICK_NINTENDO).toMatchObject({ A: 0, B: 1, X: 2, Y: 3, Select: 4, Start: 6 })
  })
  it('environnement : HIDAPI seul pour une manette Nintendo, inchangé sinon', () => {
    expect(emulatorEnv('melonds', true)).toMatchObject({ SDL_JOYSTICK_HIDAPI: '1', SDL_XINPUT_ENABLED: '0' })
    expect(emulatorEnv('retroarch', true)).toMatchObject({ SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS: '1' })
    expect(emulatorEnv('melonds')).toMatchObject({ SDL_JOYSTICK_HIDAPI: '0' })
    expect(emulatorEnv('retroarch')).toBeUndefined()
  })
})

describe('RetroArch avec une manette Nintendo', () => {
  it('pilote SDL2 et rang de la manette ; retour à XInput ensuite ; un autre pilote reste', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-'))
    const saves = mkdtempSync(join(tmpdir(), 'saves-'))
    const cfg = join(dir, 'retroarch.cfg')
    try {
      writeFileSync(cfg, 'input_joypad_driver = "xinput"\ninput_player1_joypad_index = "2"\n')
      await prepareRetroarch(dir, saves, null, { port: 0 })
      expect(readFileSync(cfg, 'utf8')).toMatch(/input_joypad_driver = "sdl2"/)
      expect(readFileSync(cfg, 'utf8')).toMatch(/input_player1_joypad_index = "0"/)
      await prepareRetroarch(dir, saves, 3, null)
      expect(readFileSync(cfg, 'utf8')).toMatch(/input_joypad_driver = "xinput"/)
      expect(readFileSync(cfg, 'utf8')).toMatch(/input_player1_joypad_index = "3"/)
      writeFileSync(cfg, 'input_joypad_driver = "dinput"\n')
      await prepareRetroarch(dir, saves, null, { port: 0 })
      expect(readFileSync(cfg, 'utf8')).toMatch(/input_joypad_driver = "dinput"/)
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(saves, { recursive: true, force: true }) }
  })
})

describe('RetroArch : stick gauche sur la croix', () => {
  it('écrit une seule fois (un choix fait ensuite dans RetroArch est respecté)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'retro-'))
    const saves = mkdtempSync(join(tmpdir(), 'saves-'))
    const cfg = join(dir, 'retroarch.cfg')
    try {
      writeFileSync(cfg, 'input_player1_analog_dpad_mode = "0"\n')
      await prepareRetroarch(dir, saves)
      expect(readFileSync(cfg, 'utf8')).toMatch(/input_player1_analog_dpad_mode = "1"/)
      writeFileSync(cfg, 'input_player1_analog_dpad_mode = "0"\n')
      await prepareRetroarch(dir, saves)
      expect(readFileSync(cfg, 'utf8')).toMatch(/input_player1_analog_dpad_mode = "0"/)
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(saves, { recursive: true, force: true }) }
  })
})

describe('Cemu et RPCS3 avec une Switch Pro : relevés des profils écrits par les émulateurs eux-mêmes', () => {
  it('Cemu : le bloc SDLController correspond à ce que Cemu a écrit pour la Pro (mapping → bouton)', async () => {
    const { cemuProfileXml } = await import('./cemu')
    const xml = cemuProfileXml('pro')
    const blocks = xml.split('<api>SDLController</api>').slice(1)
    expect(blocks).toHaveLength(2) // la Pro, puis la paire de Joy-Con réunie
    const block = blocks[0]
    const pairs = [...block.matchAll(/<mapping>(\d+)<\/mapping><button>(\d+)<\/button>/g)].map((m) => `${m[1]}:${m[2]}`)
    // Pro Nintendo.xml écrit par Cemu 2.x sur la machine de test (Home, mapping 11, non mappé).
    expect(pairs).toEqual(['1:0', '2:1', '3:2', '4:3', '5:9', '6:10', '7:42', '8:43', '9:6', '10:4', '12:11', '13:12', '14:13', '15:14', '16:7', '17:8', '18:45', '19:39', '20:44', '21:38', '22:47', '23:41', '24:46', '25:40'])
    expect(block).toContain('<uuid>0_0300b7e67e0500000920000000006803</uuid>')
    expect(blocks[1]).toContain('<uuid>0_0300460f7e0500000820000000006800</uuid>')
    expect([...blocks[1].matchAll(/<mapping>(\d+)<\/mapping><button>(\d+)<\/button>/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(pairs) // même mapping que la Pro (relevé)
  })
  it('RPCS3 : handler SDL, « Nintendo Switch Pro Controller 1 » et boutons de face par position', async () => {
    const { rpcs3InputYaml } = await import('./rpcs3')
    const y = rpcs3InputYaml('switch-pro', 0)
    expect(y).toContain('Handler: SDL')
    expect(y).toContain('Device: "Nintendo Switch Pro Controller 1"')
    for (const line of ['Square: West', 'Cross: South', 'Circle: East', 'Triangle: North', 'R1: RB', 'R2: RT', 'L1: LB', 'L2: LT', 'Start: Start', 'Select: Back', 'PS Button: Guide', 'Left Stick Up: LS Y+']) expect(y).toContain(`    ${line}\n`)
    expect(rpcs3InputYaml('switch-pro', 1)).toContain('Nintendo Switch Pro Controller 2')
  })
})

describe('DuckStation / PCSX2 : vibration et boutons de face selon la manette', () => {
  const pad = ['[Pad1]', 'Cross = Keyboard/K', 'Cross = SDL-0/A', 'Cross = SDL-1/A', 'Circle = SDL-0/B', 'Square = SDL-0/X', 'Triangle = SDL-0/Y', 'LargeMotor = SDL-0/LargeMotor', 'SmallMotor = SDL-0/SmallMotor', '[Other]', 'Cross = SDL-0/A', ''].join('\n')
  it('manette Nintendo : plus de vibration ; paire de Joy-Con : A/B et X/Y échangés ; retour à l’état d’origine ensuite', async () => {
    const { tuneSdlPad } = await import('./configure')
    const pair = tuneSdlPad(pad, { nintendo: true, swapFace: true })
    expect(pair).toMatch(/^LargeMotor = $/m)
    expect(pair).toMatch(/^SmallMotor = $/m)
    expect(pair).toMatch(/^Cross = SDL-0\/B$/m)
    expect(pair).toMatch(/^Cross = SDL-1\/B$/m)
    expect(pair).toMatch(/^Circle = SDL-0\/A$/m)
    expect(pair).toMatch(/^Square = SDL-0\/Y$/m)
    expect(pair).toMatch(/^Triangle = SDL-0\/X$/m)
    expect(pair).toMatch(/^Cross = Keyboard\/K$/m) // le clavier n'est pas touché
    expect(pair.split('[Other]')[1]).toContain('Cross = SDL-0/A') // ni les autres sections
    const pro = tuneSdlPad(pair, { nintendo: true, swapFace: false })
    expect(pro).toMatch(/^Cross = SDL-0\/A$/m)
    expect(pro).toMatch(/^LargeMotor = $/m)
    expect(tuneSdlPad(pro, { nintendo: false, swapFace: false })).toBe(pad)
  })
  it('une liaison de vibration choisie par l’utilisateur n’est pas retirée', async () => {
    const { tuneSdlPad } = await import('./configure')
    const custom = pad.replace('LargeMotor = SDL-0/LargeMotor', 'LargeMotor = SDL-2/LargeMotor')
    expect(tuneSdlPad(custom, { nintendo: true, swapFace: false })).toMatch(/^LargeMotor = SDL-2\/LargeMotor$/m)
  })
})

describe('SDL2 de RetroArch : réunion des Joy-Con', () => {
  it('lit la version dans la DLL et sait si elle réunit les Joy-Con (2.30 et au-delà)', async () => {
    const { sdl2VersionIn, sdl2CanCombineJoyCons } = await import('./sdlUpdate')
    expect(sdl2VersionIn('xx SDL2-2.0.14 yy')).toEqual([2, 0, 14])
    expect(sdl2CanCombineJoyCons([2, 0, 14])).toBe(false)
    expect(sdl2CanCombineJoyCons([2, 30, 3])).toBe(true)
    expect(sdl2CanCombineJoyCons([2, 32, 10])).toBe(true)
    expect(sdl2CanCombineJoyCons(null)).toBe(false)
  })
  it('DLL déjà récente : rien à télécharger ; téléchargement dont l’empreinte ne correspond pas : refusé, DLL intacte', async () => {
    const { ensureModernSdl2 } = await import('./sdlUpdate')
    const dir = mkdtempSync(join(tmpdir(), 'ra-'))
    const cache = mkdtempSync(join(tmpdir(), 'cache-'))
    try {
      writeFileSync(join(dir, 'SDL2.dll'), 'binaire SDL2-2.32.8 binaire')
      const never = async (): Promise<void> => { throw new Error('ne doit pas télécharger') }
      expect(await ensureModernSdl2(dir, cache, never)).toBe(true)
      writeFileSync(join(dir, 'SDL2.dll'), 'binaire SDL2-2.0.14 binaire')
      let asked = ''
      const fake = async (url: string, file: string): Promise<void> => { asked = url; writeFileSync(file, 'pas le bon fichier') }
      expect(await ensureModernSdl2(dir, cache, fake)).toBe(false)
      expect(asked).toMatch(/^https:\/\/github\.com\/libsdl-org\/SDL\/releases\/download\//)
      expect(readFileSync(join(dir, 'SDL2.dll'), 'latin1')).toContain('SDL2-2.0.14')
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }) }
  })
})

describe('RetroArch : Joy-Con seul à l\'horizontale', () => {
  it('écrit les deux profils sdl2 (L et R) sans toucher un fichier étranger', async () => {
    const { ensureRetroJoyconProfiles } = await import('./retroJoycon')
    const dir = mkdtempSync(join(tmpdir(), 'retro-jc-'))
    try {
      await ensureRetroJoyconProfiles(dir)
      const r = readFileSync(join(dir, 'autoconfig', 'sdl2', 'Nintendo Switch Joy-Con (R).cfg'), 'utf8')
      expect(r).toContain('input_device = "Nintendo Switch Joy-Con (R)"')
      expect(r).toContain('input_product_id = "8199"')
      expect(r).toContain('input_a_btn = "0"')
      expect(r).toContain('input_select_btn = "6"')
      expect(r).toContain('input_start_btn = "5"')
      expect(r).toContain('input_menu_toggle_btn = "16"')
      const l = readFileSync(join(dir, 'autoconfig', 'sdl2', 'Nintendo Switch Joy-Con (L).cfg'), 'utf8')
      expect(l).toContain('input_product_id = "8198"')
      expect(l).toContain('input_start_btn = "6"')
      expect(l).toContain('input_select_btn = "5"')
      expect(l).toContain('input_menu_toggle_btn = "17"')
      writeFileSync(join(dir, 'autoconfig', 'sdl2', 'Nintendo Switch Joy-Con (L).cfg'), 'perso')
      await ensureRetroJoyconProfiles(dir)
      expect(readFileSync(join(dir, 'autoconfig', 'sdl2', 'Nintendo Switch Joy-Con (L).cfg'), 'utf8')).toBe('perso')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
