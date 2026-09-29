import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMULATORS, emulatorMaker, emulatorRank } from '@shared/emulators'
import { applyDolphinPad, configureEmulator, isUntouchedPadFile, patchCfg, patchIni, patchYaml, resolutionTier, setCfgLanguage, setSysconfLanguage, type ConfigContext } from './configure'

describe('patchIni / patchCfg', () => {
  it('met à jour, ajoute et conserve le reste', () => {
    const src = '[Main]\r\nStartFullscreen = false\r\nKeep = 1\r\n\r\n[GPU]\r\nResolutionScale = 1\r\n'
    const out = patchIni(src, { Main: { StartFullscreen: true, Language: 'fr-FR' }, GPU: { ResolutionScale: 5 }, New: { A: 1 } })
    expect(out).toBe('[Main]\r\nStartFullscreen = true\r\nKeep = 1\r\nLanguage = fr-FR\r\n\r\n[GPU]\r\nResolutionScale = 5\r\n\r\n[New]\r\nA = 1\r\n')
  })
  it('crée un fichier vide et respecte le style Qt sans espaces', () => {
    expect(patchIni('', { UI: { 'fullscreen\\default': false, fullscreen: true } }, '=')).toBe('[UI]\nfullscreen\\default=false\nfullscreen=true\n')
  })
  it('ne confond pas une clé avec une clé au préfixe identique', () => {
    expect(patchIni('[S]\nfullscreen_mode = 1\n', { S: { fullscreen: true } })).toBe('[S]\nfullscreen_mode = 1\nfullscreen = true\n')
  })
  it('gère les clés répétées (plusieurs liaisons)', () => {
    expect(patchIni('[Pad1]\nUp = Keyboard/Up\nDown = Keyboard/Down\n', { Pad1: { Up: ['Keyboard/Up', 'SDL-0/DPadUp'], Down: ['Keyboard/Down', 'SDL-0/DPadDown'] } }))
      .toBe('[Pad1]\nUp = Keyboard/Up\nUp = SDL-0/DPadUp\nDown = Keyboard/Down\nDown = SDL-0/DPadDown\n')
    expect(patchIni('[Pad1]\nUp = a\nUp = b\nX = 1\n', { Pad1: { Up: ['c', 'd'] } })).toBe('[Pad1]\nUp = c\nUp = d\nX = 1\n')
  })
  it('change les valeurs d’un YAML sans toucher aux autres', () => {
    const src = ['a: 1', 'sys-lang: 1', 'b: x', ''].join('\n')
    expect(patchYaml(src, { 'sys-lang': 2, c: true })).toBe(['a: 1', 'sys-lang: 2', 'b: x', 'c: true', ''].join('\n'))
  })
  it('réécrit les clés RetroArch', () => {
    expect(patchCfg('video_fullscreen = "false"\nother = "x"\n', { video_fullscreen: true, user_language: 2 })).toBe('video_fullscreen = "true"\nother = "x"\nuser_language = "2"\n')
  })
})

describe('configuration automatique des émulateurs', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-cfg-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = (o: Partial<ConfigContext> = {}): ConfigContext => ({ lang: 'fr', displayHeight: 1080, biosDir: join(dir, 'bios'), ...o })
  const read = (...p: string[]): string => readFileSync(join(dir, ...p), 'utf8')

  it('choisit la résolution selon la taille de l’écran (1080p minimum)', () => {
    expect([720, 1080, 1440, 2160, 4320].map(resolutionTier)).toEqual([1, 1, 2, 3, 3])
  })
  it('DuckStation : plein écran, langue, résolution, dossier de BIOS, sans écraser le reste', async () => {
    writeFileSync(join(dir, 'settings.ini'), '[Audio]\nOutputVolume = 80\n\n[Main]\nStartFullscreen = false\n')
    await configureEmulator('duckstation', dir, ctx({ displayHeight: 2160 }))
    const t = read('settings.ini')
    expect(t).toContain('OutputVolume = 80')
    expect(t).toContain('StartFullscreen = true')
    // Les traductions sont fournies avec l'exe (translations/duckstation-qt_*.qm) : Language est sans risque, contrairement à une ancienne hypothèse.
    expect(t).toContain('Language = fr')
    expect(t).toContain('ResolutionScale = 9')
    expect(t).toContain(`SearchDirectory = ${join(dir, 'bios')}`)
    await configureEmulator('duckstation', dir, ctx({ lang: 'en' }))
    expect(read('settings.ini')).toContain('Language = en')
  })
  it('DuckStation : clavier ET manette sur chaque touche', async () => {
    await configureEmulator('duckstation', dir, ctx())
    const t = read('settings.ini')
    expect(t).toContain('Cross = Keyboard/K')
    expect(t).toContain('Cross = SDL-0/A')
    expect(t).toContain('LUp = SDL-0/-LeftY')
    expect(t).toContain('ConfirmPowerOff = false')
  })
  it('PCSX2 : passe l’assistant, plein écran, 3x (~1080p), BIOS', async () => {
    await configureEmulator('pcsx2', dir, ctx({ lang: 'en' }))
    const t = read('inis', 'PCSX2.ini')
    expect(t).toContain('SetupWizardIncomplete = false')
    expect(t).toContain('StartFullscreen = true')
    expect(t).toContain('Language = en-US')
    expect(t).toContain('SettingsVersion = 1')
    expect(t).toContain('upscale_multiplier = 3')
    expect(t).toContain('Cross = SDL-0/A')
  })
  it('Dolphin : langue GameCube, plein écran, résolution, manette, pas de fenêtre d’analyses', async () => {
    await configureEmulator('dolphin', dir, ctx())
    const ini = read('User', 'Config', 'Dolphin.ini')
    expect(ini).toMatch(/LanguageCode = fr/)
    expect(ini).toMatch(/SelectedLanguage = 2/)
    expect(ini).toMatch(/Fullscreen = true/)
    expect(ini).toContain('PermissionAsked = true')
    expect(ini).toContain('ConfirmStop = false')
    expect(read('User', 'Config', 'GFX.ini')).toContain('InternalResolution = 3')
    // Sans Dolphin.exe dans le dossier de test : clavier seul, avec le périphérique par défaut (sinon les touches ne répondent pas).
    const pad = read('User', 'Config', 'GCPadNew.ini')
    expect(pad).toContain('Device = DInput/0/Keyboard Mouse')
    expect(pad).toContain('Buttons/A = `X`\n')
    expect(pad).not.toContain('XInput')
    expect(read('User', 'Config', 'WiimoteNew.ini')).toContain('Extension = Nunchuk')
  })
  it('Dolphin : la manette branchée est écrite avec le clavier, sans citer de périphérique absent', async () => {
    await configureEmulator('dolphin', dir, ctx())
    await applyDolphinPad(dir, 1)
    const pad = read('User', 'Config', 'GCPadNew.ini')
    expect(pad).toContain('Buttons/A = `X` | `XInput/1/Gamepad:Button A`')
    expect(pad).toContain('Rumble/Motor = `XInput/1/Gamepad:Motor L` | `XInput/1/Gamepad:Motor R`')
    expect(pad).not.toContain('SDL/')
    await applyDolphinPad(dir, null)
    expect(read('User', 'Config', 'GCPadNew.ini')).not.toContain('XInput')
  })
  it('Dolphin : les liaisons modifiées à la main ne sont jamais réécrites, un fichier inutilisable l’est', () => {
    expect(isUntouchedPadFile('')).toBe(true)
    expect(isUntouchedPadFile('[GCPad1]\nButtons/A = `X` | `XInput/0/Gamepad:Button A`\n')).toBe(true)
    expect(isUntouchedPadFile('[GCPad1]\nDevice = XInput/0/Gamepad\nButtons/A = `Button A`\n')).toBe(false)
    expect(isUntouchedPadFile('[GCPad1]\nButtons/A = `Button A`\nDevice = DInput/0/Keyboard Mouse\n')).toBe(true)
  })
  it('RetroArch : langue, plein écran, quitter sans confirmation, résolution N64', async () => {
    await configureEmulator('retroarch', dir, ctx())
    const cfg = read('retroarch.cfg')
    expect(cfg).toContain('user_language = "2"')
    expect(cfg).toContain('video_fullscreen = "true"')
    expect(cfg).toContain('quit_press_twice = "false"')
    expect(read('retroarch-core-options.cfg')).toContain('mupen64plus-next-EnableNativeResFactor = "4"')
  })
  it('les fichiers YAML/XML des émulateurs à réglage unique ne sont jamais réécrits', async () => {
    writeFileSync(join(dir, 'config.yml'), 'mine: 1\n')
    await configureEmulator('rpcs3', dir, ctx())
    expect(read('config.yml')).toBe('mine: 1\n')
  })
  it('melonDS : un melonDS.toml déjà présent (lancement manuel avant l’installation par RomVault) est complété, pas ignoré', async () => {
    writeFileSync(join(dir, 'melonDS.toml'), 'mine = 1\n')
    await configureEmulator('melonds', dir, ctx())
    const t = read('melonDS.toml')
    expect(t).toContain('mine = 1')
    expect(t).toContain('[3D]\nRenderer = 1')
    expect(t).toContain('[Instance0.Firmware]')
    expect(t).toContain('OverrideSettings = true')
    expect(t).toContain('Language = 2')
  })
  it('melonDS : clavier lié (schéma IJKL/flèches), langue, résolution, sans écraser le reste', async () => {
    await configureEmulator('melonds', dir, ctx({ lang: 'en', displayHeight: 2160 }))
    const t = read('melonDS.toml')
    expect(t).toContain('ScaleFactor = 12')
    expect(t).toContain('Language = 1')
    expect(t).toContain('[Instance0.Keyboard]')
    expect(t).toContain('A = 76')
    expect(t).toContain('Up = 16777235')
    // Une 2e configuration ne perd pas ce qu'une 1re a écrit.
    await configureEmulator('melonds', dir, ctx({ lang: 'en', displayHeight: 2160 }))
    expect(read('melonDS.toml')).toContain('[3D]\nRenderer = 1')
  })
  it('Azahar : plein écran, pas de confirmation de fermeture, profil manette activé sans toucher au clavier', async () => {
    await configureEmulator('azahar', dir, ctx())
    const t = read('user', 'config', 'qt-config.ini')
    expect(t).toContain('fullscreen=true')
    expect(t).toContain('language=fr')
    // Sans ça, un « Fermer le jeu » de RomVault ouvre la boîte de confirmation d'Azahar plutôt que de fermer.
    expect(t).toContain('confirmClose=false')
    expect(t).toContain('profiles\\size=2')
    expect(t).toContain('profile=1')
    expect(t).toContain('profiles\\2\\name=Manette')
    expect(t).toMatch(/profiles\\2\\circle_pad=axis_x:0,axis_y:1,deadzone:0\.100000,engine:sdl,guid:78696e70757401000000000000000000,maptype:all,port:0/)
  })
  it('Eden : plein écran, pas de confirmation de fermeture, manette du joueur 1 sur le GUID XInput générique', async () => {
    await configureEmulator('eden', dir, ctx())
    const t = read('user', 'config', 'qt-config.ini')
    expect(t).toContain('fullscreen=true')
    expect(t).toContain('language=fr')
    // ConfirmStop::Ask_Never : sans ça, Retour+Start (fermeture RomVault) ouvre la boîte de confirmation d'Eden.
    expect(t).toContain('confirmStop=2')
    expect(t).toContain('confirmStop\\default=false')
    expect(t).toContain('player_0_button_a\\default=false')
    expect(t).toMatch(/player_0_button_a=engine:sdl,port:0,guid:78696e70757401000000000000000000,button:0/)
    expect(t).toMatch(/player_0_button_zl=engine:sdl,port:0,guid:78696e70757401000000000000000000,axis:4,threshold:0\.5,invert:\+/)
    expect(t).toMatch(/player_0_lstick=engine:sdl,port:0,guid:78696e70757401000000000000000000,axis_x:0,axis_y:1,offset_x:0,offset_y:0,invert_x:\+,invert_y:\+/)
  })
  it('Cemu : sortie audio par défaut, clavier ET 1ère manette XInput sur le Pad 1', async () => {
    await configureEmulator('cemu', dir, ctx())
    const settings = read('settings.xml')
    expect(settings).toContain('<TVDevice>default</TVDevice>')
    expect(settings).toContain('<PadDevice>default</PadDevice>')
    expect(settings).toContain('<TVVolume>100</TVVolume>')
    const profile = read('controllerProfiles', 'controller0.xml')
    expect(profile).toContain('<type>Wii U GamePad</type>')
    expect(profile).toContain('<api>Keyboard</api>')
    expect(profile).toContain('<uuid>keyboard</uuid>')
    // A -> touche L (schéma IJKL de ce fichier)
    expect(profile).toContain('<entry><mapping>1</mapping><button>76</button></entry>')
    expect(profile).toContain('<api>XInput</api>')
    expect(profile).toContain('<uuid>0</uuid>')
  })
  it('chaque émulateur produit au moins un fichier de configuration', async () => {
    for (const d of EMULATORS) {
      const sub = join(dir, d.id)
      await configureEmulator(d.id, sub, ctx())
      expect(existsSync(sub), d.id).toBe(true)
    }
  })
})

describe('SYSCONF de la Wii', () => {
  it('change la langue (octet IPL.LNG) sans toucher au reste', () => {
    // Fichier minimal : 2 entrées, dont IPL.LNG (type octet = 3).
    const b = Buffer.alloc(64)
    b.write('SCv0', 0, 'latin1'); b.writeUInt16BE(2, 4); b.writeUInt16BE(10, 6); b.writeUInt16BE(24, 8)
    b[10] = (2 << 5) | 6; b.write('IPL.NIK', 11, 'latin1'); b[18] = 21
    b[24] = (3 << 5) | 6; b.write('IPL.LNG', 25, 'latin1'); b[32] = 1
    expect(setSysconfLanguage(b, 3)).toBe(true)
    expect(b[32]).toBe(3)
    expect(b[18]).toBe(21)
    expect(setSysconfLanguage(Buffer.from('nope'), 3)).toBe(false)
  })
})

describe('config du NAND émulé de la 3DS (Azahar)', () => {
  /** Table à 2 entrées (12 octets chacune) façon service CFG : un bloc quelconque puis la langue (0x000A0002). */
  function makeCfg(languageValue: number): Buffer {
    const b = Buffer.alloc(4 + 2 * 12)
    b.writeUInt16LE(2, 0); b.writeUInt16LE(28, 2)
    b.writeUInt32LE(0x000a0000, 4); b.writeUInt32LE(0x1234, 8); b.writeUInt16LE(28, 12); b.writeUInt16LE(0xe, 14)
    b.writeUInt32LE(0x000a0002, 16); b.writeUInt32LE(languageValue, 20); b.writeUInt16LE(1, 24); b.writeUInt16LE(0xe, 26)
    return b
  }
  it('change la langue (bloc 0x000A0002) sans toucher aux autres blocs', () => {
    const b = makeCfg(1)
    expect(setCfgLanguage(b, 2)).toBe(true)
    expect(b.readUInt32LE(20)).toBe(2)
    expect(b.readUInt32LE(8)).toBe(0x1234) // bloc précédent intact
  })
  it('renvoie faux si le bloc langue est absent ou le fichier trop court', () => {
    const b = makeCfg(1)
    b.writeUInt32LE(0x11111111, 16) // masque le block_id de la langue
    expect(setCfgLanguage(b, 2)).toBe(false)
    expect(setCfgLanguage(Buffer.alloc(2), 2)).toBe(false)
  })
})

describe('classement des émulateurs', () => {
  it('Nintendo puis Sony, dans l’ordre de sortie des consoles du catalogue', () => {
    const order = (maker: string): string[] => EMULATORS.filter((e) => emulatorMaker(e) === maker).sort((a, b) => emulatorRank(a) - emulatorRank(b)).map((e) => e.id)
    expect(order('Nintendo')).toEqual(['retroarch', 'melonds', 'azahar', 'dolphin', 'cemu', 'eden'])
    expect(order('Sony')).toEqual(['duckstation', 'pcsx2', 'rpcs3', 'ppsspp', 'vita3k'])
  })
})
