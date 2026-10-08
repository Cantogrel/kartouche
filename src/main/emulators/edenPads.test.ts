import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEdenPad, applyEdenPads, isUntouchedEdenControls } from './configure'
import { edenNintendoProfile, isNintendoButtonA, type EdenNintendo } from './edenPads'
import { edenRefusalReason, pickEdenPad, pickEdenPads, shouldCloseOnRefusal } from './edenChoice'
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
    const mine = 'player_0_button_a\\default=false\nplayer_0_button_a="engine:keyboard,code:90,toggle:0"\nplayer_0_type\\default=false\nplayer_0_type=3\n'
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

describe('Eden : plusieurs joueurs', () => {
  it("le profil d'un Joy-Con droit seul au joueur 2 est exactement celui qu'Eden a écrit pour le joueur 2", () => {
    const p2 = edenNintendoProfile('joycon-right', 1)
    const real = Object.fromEntries(EDEN_REAL['joycon-right'].map(([k, v]) => [k.replace('player_0_', 'player_1_'), v]))
    expect({ ...p2.keys, player_1_type: String(p2.type) }).toEqual(real)
  })

  it('un profil par joueur, avec son type et sa présence', async () => {
    const dir = await edenDir()
    await applyEdenPads(dir, [{ vid: 0x045e, pid: 0x02ff, ver: 0 }, { nintendo: 'switch-pro' }, { nintendo: 'joycon-pair' }])
    const c = await controls(dir)
    expect(c['player_0_button_a']).toBe('engine:sdl,port:0,guid:030000005e040000ff02000000007801,button:1')
    expect(c['player_1_button_a']).toBe('engine:sdl,port:0,guid:030000007e0500000920000000006803,button:1')
    expect(c['player_1_type']).toBe('0')
    expect(c['player_1_connected']).toBe('true')
    expect(c['player_1_connected\\default']).toBe('false')
    expect(c['player_2_button_a']).toBe('engine:joycon,guid:00000000000000000000000000000002,port:0,pad:2,button:2048')
    expect(c['player_2_type']).toBe('1')
    expect(c['player_2_connected']).toBe('true')
    expect(c['player_3_connected']).toBeUndefined()
    // le joueur 1 est toujours connecté par défaut : pas de réglage « connected » à écrire pour lui
    expect(c['player_0_connected']).toBeUndefined()
  })

  it('deux manettes identiques : la deuxième prend le port 1', async () => {
    const dir = await edenDir()
    await applyEdenPads(dir, [{ vid: 0x045e, pid: 0x02ff, ver: 0, port: 0 }, { vid: 0x045e, pid: 0x02ff, ver: 0, port: 1 }])
    const c = await controls(dir)
    expect(c['player_0_button_a']).toContain('port:0,guid:030000005e040000ff02000000007801')
    expect(c['player_1_button_a']).toContain('port:1,guid:030000005e040000ff02000000007801')
    expect(c['player_1_lstick']).toContain('port:1')
  })

  it('un joueur qui disparaît revient par défaut, les autres restent', async () => {
    const dir = await edenDir()
    await applyEdenPads(dir, [{ nintendo: 'switch-pro' }, { nintendo: 'joycon-pair' }, { vid: 0x045e, pid: 0x02ff, ver: 0 }])
    await applyEdenPads(dir, [{ nintendo: 'switch-pro' }])
    const c = await controls(dir)
    expect(c['player_0_button_a\\default']).toBe('false')
    for (const k of ['player_1_button_a', 'player_1_type', 'player_1_connected', 'player_1_motionleft', 'player_2_button_a', 'player_2_connected']) expect(c[`${k}\\default`]).toBe('true')
  })

  it("un joueur configuré à la main n'est jamais réécrit, les autres le sont", async () => {
    const mine = 'player_1_button_a\\default=false\nplayer_1_button_a="engine:keyboard,code:90,toggle:0"\nplayer_1_type\\default=false\nplayer_1_type=5\n'
    const dir = await edenDir(mine)
    await applyEdenPads(dir, [{ nintendo: 'switch-pro' }, { nintendo: 'joycon-pair' }, { nintendo: 'joycon-left' }])
    const c = await controls(dir)
    expect(c['player_1_button_a']).toBe('engine:keyboard,code:90,toggle:0')
    expect(c['player_1_type']).toBe('5')
    expect(c['player_0_button_a']).toContain('engine:sdl')
    expect(c['player_2_button_a']).toContain('engine:joycon')
    expect(c['player_2_type']).toBe('2')
  })

  it('jamais plus de huit joueurs', async () => {
    const dir = await edenDir()
    await applyEdenPads(dir, Array.from({ length: 10 }, () => ({ nintendo: 'switch-pro' as const })))
    const c = await controls(dir)
    expect(c['player_7_button_a']).toBeDefined()
    expect(c['player_8_button_a']).toBeUndefined()
  })
})

describe('Eden : attribution des joueurs', () => {
  const pro = [0x2009]
  const pair = [0x2006, 0x2007]
  const pad = (slot: number, vid = 0x045e, pid = 0x02ff): XInputPad => ({ slot, vid, pid, ver: 0 })

  it('sans information : XInput, Switch Pro, paire de Joy-Con', () => {
    expect(pickEdenPads([pad(0)], [...pro, ...pair], null)).toEqual([
      { vid: 0x045e, pid: 0x02ff, ver: 0, port: 0 }, { nintendo: 'switch-pro', port: 0 }, { nintendo: 'joycon-pair', port: 0 }
    ])
  })

  it("le joueur 1 est la dernière manette utilisée, les autres suivent dans l'ordre stable", () => {
    expect(pickEdenPads([pad(0)], [...pro, ...pair], { source: 'hid', pid: 0x2007 })).toEqual([
      { nintendo: 'joycon-pair', port: 0 }, { vid: 0x045e, pid: 0x02ff, ver: 0, port: 0 }, { nintendo: 'switch-pro', port: 0 }
    ])
    expect(pickEdenPads([pad(0)], [...pro, ...pair], { source: 'hid', pid: 0x2009 })[0]).toEqual({ nintendo: 'switch-pro', port: 0 })
  })

  it('une paire de Joy-Con est une seule manette, deux Joy-Con de même côté deux manettes', () => {
    expect(pickEdenPads([], pair, null)).toEqual([{ nintendo: 'joycon-pair', port: 0 }])
    expect(pickEdenPads([], [0x2006, 0x2006], null)).toEqual([{ nintendo: 'joycon-left', port: 0 }, { nintendo: 'joycon-left', port: 1 }])
    expect(pickEdenPads([], [0x2006, 0x2006, 0x2007], null)).toEqual([{ nintendo: 'joycon-pair', port: 0 }, { nintendo: 'joycon-left', port: 0 }])
  })

  it('manettes XInput identiques : port par rang ; identités différentes : chacune son port 0', () => {
    expect(pickEdenPads([pad(0), pad(1)], [], null)).toEqual([
      { vid: 0x045e, pid: 0x02ff, ver: 0, port: 0 }, { vid: 0x045e, pid: 0x02ff, ver: 0, port: 1 }
    ])
    expect(pickEdenPads([pad(0), pad(1, 0x045e, 0x028e)], [], null).map((p) => ('port' in p ? p.port : -1))).toEqual([0, 0])
  })

  it('plusieurs XInput dont une « dernière utilisée » : elle passe en premier', () => {
    expect(pickEdenPads([pad(0), pad(1, 0x045e, 0x028e)], [], { source: 'xinput', slot: 1 })).toEqual([
      { vid: 0x045e, pid: 0x028e, ver: 0, port: 0 }, { vid: 0x045e, pid: 0x02ff, ver: 0, port: 0 }
    ])
  })

  it("joueur seul avec plusieurs manettes allumées : la première est celle qu'il tient (dernière utilisée)", () => {
    expect(pickEdenPad([pad(0)], [...pro, ...pair], { source: 'hid', pid: 0x2009 })).toEqual({ nintendo: 'switch-pro' })
  })

  it('rien : pas de joueur (clavier)', () => {
    expect(pickEdenPads([], [], null)).toEqual([])
  })
})

describe('Eden : config déjà sauvegardée par Eden', () => {
  // Constaté sur le vrai Eden : à sa première sauvegarde il écrit la touche par défaut de CHAQUE joueur avec « default=false ».
  const SAVED = [1, 2, 3].map((n) => `player_${n}_button_a\\default=false\nplayer_${n}_button_a="engine:keyboard,code:67,toggle:0"\nplayer_${n}_type\\default=true\nplayer_${n}_type=0\nplayer_${n}_connected\\default=true\nplayer_${n}_connected=false\n`).join('')

  it('les touches clavier par défaut des autres joueurs ne sont pas prises pour un réglage de l\'utilisateur', async () => {
    const dir = await edenDir(SAVED)
    await applyEdenPads(dir, [{ nintendo: 'switch-pro' }, { nintendo: 'joycon-right' }])
    const c = await controls(dir)
    expect(c['player_1_button_a']).toContain('engine:joycon,guid:00000000000000000000000000000002,port:0,pad:2,button:2048')
    expect(c['player_1_type']).toBe('3')
    expect(c['player_1_connected']).toBe('true')
    expect(c['player_1_connected\\default']).toBe('false')
  })

  it('un joueur sans manette garde ses touches par défaut et reste absent', async () => {
    const dir = await edenDir(SAVED)
    await applyEdenPads(dir, [{ nintendo: 'switch-pro' }])
    const c = await controls(dir)
    expect(c['player_1_connected']).toBe('false')
    expect(c['player_1_button_a']).toBe('engine:keyboard,code:67,toggle:0')
  })
})

describe('Eden : applet Contrôleur', () => {
  const off = async (pads: Parameters<typeof applyEdenPads>[1]): Promise<Record<string, string>> => {
    const dir = await edenDir()
    await applyEdenPads(dir, pads)
    return controls(dir)
  }
  it('désactivée avec une Switch Pro ou une paire de Joy-Con (plus de fenêtre à chaque + ou -)', async () => {
    for (const pads of [[{ nintendo: 'switch-pro' as const }], [{ nintendo: 'joycon-pair' as const }, { nintendo: 'switch-pro' as const }], [{ vid: 1, pid: 2, ver: 3 }, { nintendo: 'switch-pro' as const }]]) {
      const c = await off(pads)
      expect(c['disableControllerApplet']).toBe('true')
      expect(c['disableControllerApplet\\default']).toBe('false')
    }
  })

  it("laissée active avec un Joy-Con seul (Eden le défait sinon), sans manette Nintendo ou sans manette", async () => {
    for (const pads of [[{ nintendo: 'joycon-right' as const }], [{ nintendo: 'switch-pro' as const }, { nintendo: 'joycon-left' as const }], [{ vid: 1, pid: 2, ver: 3 }], []]) {
      expect((await off(pads))['disableControllerApplet']).toBeUndefined()
    }
  })

  it("rétablit l'option dès qu'elle ne convient plus (Joy-Con seul), repérée par le marqueur de Kartouche", async () => {
    const dir = await edenDir()
    await applyEdenPads(dir, [{ nintendo: 'switch-pro' }])
    expect((await controls(dir))['disableControllerApplet']).toBe('true')
    await applyEdenPads(dir, [{ nintendo: 'joycon-right' }])
    expect((await controls(dir))['disableControllerApplet\\default']).toBe('true')
  })

  it("laisse tel quel un réglage fait par l'utilisateur (pas de marqueur)", async () => {
    const dir = await edenDir(['disableControllerApplet\\default=false', 'disableControllerApplet=true', ''].join('\n'))
    await applyEdenPads(dir, [{ nintendo: 'switch-pro' }])
    const c = await controls(dir)
    expect(c['disableControllerApplet']).toBe('true')
    expect(c['disableControllerApplet\\default']).toBe('false')
    await applyEdenPads(dir, [{ nintendo: 'joycon-right' }])
    expect((await controls(dir))['disableControllerApplet']).toBe('true') // et on ne le rétablit pas non plus
  })
})

describe('Eden : manettes refusées par le jeu', () => {
  it('un Joy-Con seul parmi les manettes assignées : message « Joy-Con seul »', () => {
    expect(edenRefusalReason([{ nintendo: 'joycon-left' }])).toBe('padRefusedJoycon')
    expect(edenRefusalReason([{ nintendo: 'switch-pro' }, { nintendo: 'joycon-right' }])).toBe('padRefusedJoycon')
  })

  it('sinon, le jeu veut plus de manettes que celles branchées', () => {
    expect(edenRefusalReason([{ nintendo: 'switch-pro' }])).toBe('padRefusedCount')
    expect(edenRefusalReason([{ nintendo: 'joycon-pair' }, { vid: 0x045e, pid: 0x02ff, ver: 0 }])).toBe('padRefusedCount')
    expect(edenRefusalReason([])).toBe('padRefusedCount')
  })
})

describe('Eden : quand fermer le jeu sur un refus', () => {
  it('seulement au démarrage, jamais en pleine partie', () => {
    expect(shouldCloseOnRefusal(5_000)).toBe(true)
    expect(shouldCloseOnRefusal(60_000)).toBe(true)
    expect(shouldCloseOnRefusal(60_001)).toBe(false)
    expect(shouldCloseOnRefusal(20 * 60_000)).toBe(false)
  })
})
