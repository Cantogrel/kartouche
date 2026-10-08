import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEdenPad, isUntouchedEdenControls } from './configure'
import { edenNintendoProfile, isNintendoButtonA, type EdenNintendo } from './edenPads'
import { pickEdenPad } from './edenChoice'
import { EDEN_REAL } from './edenReal.fixture'
import type { XInputPad } from './quit'

const KINDS: EdenNintendo[] = ['switch-pro', 'joycon-pair', 'joycon-left', 'joycon-right']
const xbox: XInputPad = { slot: 0, vid: 0x045e, pid: 0x02ff, ver: 0 }

/** La config d'Eden après un lancement : `Controls` lu clé par clé (les valeurs sont entre guillemets quand elles contiennent des virgules). */
async function controls(dir: string): Promise<Record<string, string>> {
  const text = (await readFile(join(dir, 'user', 'config', 'qt-config.ini'), 'utf8')).replace(/\r\n/g, '\n')
  const out: Record<string, string> = {}
  for (const l of text.split('\n')) {
    const i = l.indexOf('=')
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1).replace(/^"(.*)"$/, '$1')
  }
  return out
}

async function edenDir(initial = ''): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eden-pads-'))
  await mkdir(join(dir, 'user', 'config'), { recursive: true })
  await writeFile(join(dir, 'user', 'config', 'qt-config.ini'), initial)
  return dir
}

describe('profils Eden des manettes Nintendo', () => {
  for (const kind of KINDS) {
    it(`${kind} : identique à ce qu'Eden écrit lui-même`, () => {
      const p = edenNintendoProfile(kind)
      const mine = Object.fromEntries([...Object.entries(p.keys), ['player_0_type', String(p.type)]])
      // Le décalage d'un stick est l'étalonnage de la manette de la personne qui a fait le relevé : propre à chaque manette, on écrit 0.
      const real = Object.fromEntries(EDEN_REAL[kind].map(([k, v]) => [k, v.replace(/offset_x:-?\d+(\.\d+)?,offset_y:-?\d+(\.\d+)?/, 'offset_x:0.000000,offset_y:0.000000')]))
      expect(mine).toEqual(real)
    })
  }

  it('reconnaît ses propres profils, pas une liaison faite à la main', () => {
    for (const kind of KINDS) expect(isNintendoButtonA(edenNintendoProfile(kind).keys.player_0_button_a)).toBe(true)
    expect(isNintendoButtonA('engine:keyboard,code:67,toggle:0')).toBe(false)
    expect(isNintendoButtonA('engine:sdl,port:0,guid:030000005e040000ff02000000007801,button:1')).toBe(false)
  })
})

describe('Eden : profil écrit au lancement', () => {
  it('paire de Joy-Con : liaisons Joy-Con et type « paire », valeurs entre guillemets', async () => {
    const dir = await edenDir()
    await applyEdenPad(dir, { nintendo: 'joycon-pair' })
    const c = await controls(dir)
    expect(c['player_0_type']).toBe('1')
    expect(c['player_0_type\\default']).toBe('false')
    expect(c['player_0_button_a']).toBe('engine:joycon,guid:00000000000000000000000000000002,port:0,pad:2,button:2048')
    expect(c['player_0_motionleft']).toBe('engine:joycon,guid:00000000000000000000000000000001,port:0,pad:1,motion:0')
    expect(await readFile(join(dir, 'user', 'config', 'qt-config.ini'), 'utf8')).toMatch(/player_0_button_a="engine:joycon/)
  })

  it('Switch Pro : liaisons SDL du pilote HIDAPI et type Pro Controller', async () => {
    const dir = await edenDir()
    await applyEdenPad(dir, { nintendo: 'switch-pro' })
    const c = await controls(dir)
    expect(c['player_0_type']).toBe('0')
    expect(c['player_0_button_a']).toBe('engine:sdl,port:0,guid:030000007e0500000920000000006803,button:1')
    expect(c['player_0_button_home']).toBe('engine:sdl,port:0,guid:030000007e0500000920000000006803,button:5')
  })

  it('Nintendo puis XInput : mouvement, Home et type reviennent par défaut, les boutons passent en XInput', async () => {
    const dir = await edenDir()
    await applyEdenPad(dir, { nintendo: 'joycon-pair' })
    await applyEdenPad(dir, { vid: 0x045e, pid: 0x02ff, ver: 0 })
    const c = await controls(dir)
    expect(c['player_0_type\\default']).toBe('true')
    expect(c['player_0_motionleft\\default']).toBe('true')
    expect(c['player_0_button_home\\default']).toBe('true')
    expect(c['player_0_button_a\\default']).toBe('false')
    expect(c['player_0_button_a']).toBe('engine:sdl,port:0,guid:030000005e040000ff02000000007801,button:1')
  })

  it('Nintendo puis rien de branché : tout revient par défaut (clavier d\'Eden)', async () => {
    const dir = await edenDir()
    await applyEdenPad(dir, { nintendo: 'switch-pro' })
    await applyEdenPad(dir, null)
    const c = await controls(dir)
    for (const k of ['player_0_button_a', 'player_0_lstick', 'player_0_motionleft', 'player_0_button_home', 'player_0_type']) expect(c[`${k}\\default`]).toBe('true')
  })

  it('d\'un profil Nintendo à un autre : celui du dessus remplace l\'autre, sans reste', async () => {
    const dir = await edenDir()
    await applyEdenPad(dir, { nintendo: 'joycon-pair' })
    await applyEdenPad(dir, { nintendo: 'switch-pro' })
    const c = await controls(dir)
    expect(c['player_0_type']).toBe('0')
    expect(c['player_0_lstick']).toContain('engine:sdl')
    expect(c['player_0_motionright']).toContain('engine:sdl')
  })

  it('XInput seul : comportement d\'avant, Home / mouvement / type jamais touchés', async () => {
    const dir = await edenDir()
    await applyEdenPad(dir, { vid: 0x045e, pid: 0x02ff, ver: 0 })
    const c = await controls(dir)
    expect(c['player_0_button_a']).toBe('engine:sdl,port:0,guid:030000005e040000ff02000000007801,button:1')
    expect(c['player_0_type']).toBeUndefined()
    expect(c['player_0_button_home\\default']).toBeUndefined()
    expect(c['player_0_motionleft\\default']).toBeUndefined()
  })

  it('une manette configurée à la main dans Eden n\'est jamais réécrite, Nintendo ou non', async () => {
    const mine = 'player_0_button_a\\default=false\nplayer_0_button_a="engine:keyboard,code:67,toggle:0"\nplayer_0_type\\default=false\nplayer_0_type=3\n'
    const dir = await edenDir(mine)
    await applyEdenPad(dir, { nintendo: 'joycon-pair' })
    await applyEdenPad(dir, { vid: 0x045e, pid: 0x02ff, ver: 0 })
    await applyEdenPad(dir, null)
    expect(await readFile(join(dir, 'user', 'config', 'qt-config.ini'), 'utf8').then((t) => t.replace(/\r\n/g, '\n'))).toBe(mine)
  })

  it('un profil Nintendo écrit par Kartouche compte comme le sien (modifiable au lancement suivant)', () => {
    expect(isUntouchedEdenControls('player_0_button_a\\default=false\nplayer_0_button_a="engine:joycon,guid:00000000000000000000000000000002,port:0,pad:2,button:2048"\n')).toBe(true)
    expect(isUntouchedEdenControls('player_0_button_a\\default=false\nplayer_0_button_a="engine:sdl,port:0,guid:030000007e0500000920000000006803,button:1"\n')).toBe(true)
  })
})

describe('Eden : quelle manette lire', () => {
  const pro = [0x2009]
  const pair = [0x2006, 0x2007]

  it('rien : clavier', () => {
    expect(pickEdenPad([], [], null)).toBeNull()
  })

  it('XInput seule : comme avant', () => {
    expect(pickEdenPad([xbox], [], null)).toEqual({ vid: 0x045e, pid: 0x02ff, ver: 0 })
  })

  it('XInput et Switch Pro, sans information : XInput d\'abord, comme avant', () => {
    expect(pickEdenPad([xbox], pro, null)).toEqual({ vid: 0x045e, pid: 0x02ff, ver: 0 })
  })

  it('XInput et Switch Pro, la Pro utilisée en dernier : la Pro', () => {
    expect(pickEdenPad([xbox], pro, { source: 'hid', pid: 0x2009 })).toEqual({ nintendo: 'switch-pro' })
  })

  it('XInput et Switch Pro, la XInput utilisée en dernier : la XInput', () => {
    expect(pickEdenPad([xbox], pro, { source: 'xinput', slot: 0 })).toEqual({ vid: 0x045e, pid: 0x02ff, ver: 0 })
  })

  it('Joy-Con : paire, gauche seul, droit seul', () => {
    expect(pickEdenPad([], pair, null)).toEqual({ nintendo: 'joycon-pair' })
    expect(pickEdenPad([], [0x2006], null)).toEqual({ nintendo: 'joycon-left' })
    expect(pickEdenPad([], [0x2007], null)).toEqual({ nintendo: 'joycon-right' })
  })

  it('plusieurs XInput : la dernière utilisée si elle est connue, sinon la première', () => {
    const a: XInputPad = { slot: 0, vid: 0x045e, pid: 0x028e, ver: 0 }
    const b: XInputPad = { slot: 1, vid: 0x045e, pid: 0x02ff, ver: 0 }
    expect(pickEdenPad([a, b], [], { source: 'xinput', slot: 1 })).toEqual({ vid: 0x045e, pid: 0x02ff, ver: 0 })
    expect(pickEdenPad([a, b], [], null)).toEqual({ vid: 0x045e, pid: 0x028e, ver: 0 })
  })

  it('la dernière utilisée est une manette Nintendo débranchée : retour à la règle d\'avant pour les XInput', () => {
    const order = (pads: readonly XInputPad[]): XInputPad[] => [...pads].reverse()
    const a: XInputPad = { slot: 0, vid: 1, pid: 1, ver: 0 }
    const b: XInputPad = { slot: 1, vid: 2, pid: 2, ver: 0 }
    expect(pickEdenPad([a, b], [], { source: 'hid', pid: 0x2009 }, order)).toEqual({ vid: 2, pid: 2, ver: 0 })
  })
})
