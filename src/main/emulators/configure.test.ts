import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMULATORS, emulatorMaker, emulatorRank } from '@shared/emulators'
import { dolphinScale, isUntouchedWiimoteFile } from './dolphin'
import { n64Factor } from './retroarch'
import { duckstationScale, readPs1Serial, serialFromBoot } from './duckstation'
import { pcsx2Scale, ps2ElfCrc, ps2SerialFromBoot, readPs2Game } from './pcsx2'
import { ppssppGraphics, ppssppScale, readPspDiscId } from './ppsspp'
import { vita3kScale } from './vita3k'
import { readPs3Serial, rpcs3ConfigYaml, rpcs3InputYaml, rpcs3Scale, sfoString } from './rpcs3'
import { azaharScale, ncsdTitleId } from './azahar'
import { melondsRendering, ndsGameCode, tomlSection } from './melonds'
import { edenResolution, hasQuarterResolutions } from './eden'
import { emulatorEnv } from './sdlEnv'
import { applyDolphinFastDiscExclusion, applyDuckstationGame, applyPcsx2Game, applyPpssppGame, applyRpcs3Game, applyRpcs3Pad, applyAzaharGameConfig, applyAzaharPad, applyMelondsGame, applyEdenGameConfig, applyEdenPad, isUntouchedEdenControls, sdlXInputGuid, applyDolphinPad, configureEmulator, isUntouchedPadFile, patchCfg, patchIni, patchYaml, resolutionTier, setCfgLanguage, setSysconfLanguage, type ConfigContext } from './configure'

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
    expect(t).toContain('ResolutionScale = 6')
    expect(t).toContain(`SearchDirectory = ${join(dir, 'bios')}`)
    await configureEmulator('duckstation', dir, ctx({ lang: 'en' }))
    expect(read('settings.ini')).toContain('Language = en')
  })
  it('DuckStation : Vulkan sur le GPU détecté, résolution selon l’écran, PGXP sûr, pas de widescreen ni de mode CPU', async () => {
    await configureEmulator('duckstation', dir, ctx({ gpu: { vulkan: true, tier: 'high', name: 'NVIDIA GeForce RTX 3060' } }))
    const t = read('settings.ini')
    expect(t).toContain('Renderer = Vulkan')
    expect(t).toContain('Adapter = NVIDIA GeForce RTX 3060')
    expect(t).toContain('ResolutionScale = 5')
    for (const k of ['PGXPEnable = true', 'PGXPCulling = true', 'PGXPTextureCorrection = true', 'PGXPDepthBuffer = true']) expect(t).toContain(k)
    expect(t).not.toMatch(/WidescreenHack|PGXPCPU|PGXPVertexCache|AspectRatio/)
    // Audio : aucun réglage écrit, les défauts (100 %, périphérique Windows) s'appliquent.
    expect(t).not.toMatch(/\[Audio\]|OutputVolume|OutputDevice/)
  })
  it('DuckStation : Direct3D 11 sans Vulkan, iGPU sans tampon de profondeur ni grosse résolution', async () => {
    await configureEmulator('duckstation', dir, ctx({ displayHeight: 2160, gpu: { vulkan: false, tier: 'igpu', name: 'Intel(R) HD Graphics 4600' } }))
    const t = read('settings.ini')
    expect(t).toContain('Renderer = D3D11')
    expect(t).not.toContain('Adapter =')
    expect(t).toContain('ResolutionScale = 2')
    expect(t).toContain('PGXPDepthBuffer = false')
    expect(duckstationScale({ vulkan: true, tier: 'high' }, 1440)).toBe(6)
    expect(duckstationScale({ vulkan: true, tier: 'high' }, 2160)).toBe(9)
    expect(duckstationScale({ vulkan: true, tier: 'low' }, 1080)).toBe(3)
  })
  it('DuckStation : réglages par jeu pour le seul numéro de série connu ; carte propre au jeu seulement si la carte globale est partagée ; jamais écrasés', async () => {
    const table = { 'SCES-01438': { GPU: { ResolutionScale: 2 }, ControllerPorts: { UseGameSettingsForController: true } } }
    await applyDuckstationGame(dir, 'SLUS-00001', table)
    expect(existsSync(join(dir, 'gamesettings'))).toBe(false) // carte par titre (défaut) : déjà propre à chaque jeu, rien à écrire
    await applyDuckstationGame(dir, 'sces-01438', table)
    expect(read('gamesettings', 'SCES-01438.ini')).toContain('ResolutionScale = 2')
    expect(read('gamesettings', 'SCES-01438.ini')).not.toContain('Card1Type')
    writeFileSync(join(dir, 'settings.ini'), '[MemoryCards]\nCard1Type = Shared\nCard2Type = None\n')
    await applyDuckstationGame(dir, 'SLUS-00001', table)
    expect(read('gamesettings', 'SLUS-00001.ini')).toContain('Card1Type = PerGame')
    expect(read('gamesettings', 'SLUS-00001.ini')).not.toContain('Card2Type')
    writeFileSync(join(dir, 'gamesettings', 'SCES-01438.ini'), 'perso')
    await applyDuckstationGame(dir, 'SCES-01438', table)
    expect(read('gamesettings', 'SCES-01438.ini')).toBe('perso')
    expect(serialFromBoot('cdrom:\\SCES_014.38;1')).toBe('SCES-01438')
    expect(serialFromBoot('cdrom:\\SLUS_006.94;1')).toBe('SLUS-00694')
    expect(serialFromBoot('cdrom:SLPS-01234;1')).toBe('SLPS-01234')
    // Image ISO 9660 minimale (secteurs de 2048) : racine avec SYSTEM.CNF.
    const iso = Buffer.alloc(2048 * 20)
    iso.write('CD001', 16 * 2048 + 1, 'latin1')
    iso.writeUInt32LE(18, 16 * 2048 + 156 + 2); iso.writeUInt32LE(2048, 16 * 2048 + 156 + 10)
    const rec = 18 * 2048
    iso[rec] = 44; iso.writeUInt32LE(19, rec + 2); iso.writeUInt32LE(40, rec + 10); iso[rec + 32] = 12; iso.write('SYSTEM.CNF;1', rec + 33, 'latin1')
    iso.write('BOOT = cdrom:\\SCES_014.38;1\r\n', 19 * 2048, 'latin1')
    writeFileSync(join(dir, 'jeu.iso'), iso)
    expect(await readPs1Serial(join(dir, 'jeu.iso'))).toBe('SCES-01438')
    writeFileSync(join(dir, 'jeu.cue'), 'FILE "jeu.iso" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n')
    expect(await readPs1Serial(join(dir, 'jeu.cue'))).toBe('SCES-01438')
    expect(await readPs1Serial(join(dir, 'jeu.chd'))).toBeNull()
  })
  it('DuckStation : clavier ET manette sur chaque touche', async () => {
    await configureEmulator('duckstation', dir, ctx())
    const t = read('settings.ini')
    expect(t).toContain('Cross = Keyboard/K')
    expect(t).toContain('Cross = SDL-0/A')
    expect(t).toContain('LUp = SDL-0/-LeftY')
    expect(t).toContain('ConfirmPowerOff = false')
  })
  it('PCSX2 : Vulkan sur le GPU détecté, résolution selon l’écran, ni widescreen ni hack, profils de manette réutilisables', async () => {
    await configureEmulator('pcsx2', dir, ctx({ gpu: { vulkan: true, tier: 'high', name: 'NVIDIA GeForce RTX 3060' } }))
    const t = read('inis', 'PCSX2.ini')
    expect(t).toContain('Renderer = 14')
    expect(t).toContain('Adapter = NVIDIA GeForce RTX 3060')
    expect(t).toContain('upscale_multiplier = 3')
    expect(t).not.toMatch(/UserHacks|EnableWideScreenPatches|AspectRatio|OutputVolume|StandardVolume/)
    // Manette et clavier restent liés ensemble dans la configuration globale.
    expect(t).toContain('Cross = Keyboard/K')
    expect(t).toContain('Cross = SDL-0/A')
    // Profils : manette SDL seule, clavier seul ; jamais écrasés.
    const pad = read('inputprofiles', 'RomVault Manette.ini')
    expect(pad).toContain('Cross = SDL-0/A')
    expect(pad).not.toContain('Keyboard/')
    const kb = read('inputprofiles', 'RomVault Clavier.ini')
    expect(kb).toContain('Cross = Keyboard/K')
    expect(kb).not.toContain('SDL-0')
    writeFileSync(join(dir, 'inputprofiles', 'RomVault Manette.ini'), 'perso')
    await configureEmulator('pcsx2', dir, ctx())
    expect(read('inputprofiles', 'RomVault Manette.ini')).toBe('perso')
  })
  it('PCSX2 : Direct3D 11 sans Vulkan, résolution bornée sur iGPU', async () => {
    await configureEmulator('pcsx2', dir, ctx({ displayHeight: 2160, gpu: { vulkan: false, tier: 'igpu', name: 'Intel(R) HD Graphics 4600' } }))
    const t = read('inis', 'PCSX2.ini')
    expect(t).toContain('Renderer = 3')
    expect(t).toContain('upscale_multiplier = 2')
    expect(pcsx2Scale({ vulkan: true, tier: 'high' }, 1440)).toBe(4)
    expect(pcsx2Scale({ vulkan: true, tier: 'high' }, 2160)).toBe(6)
    expect(pcsx2Scale({ vulkan: true, tier: 'low' }, 1080)).toBe(3)
  })
  it('PCSX2 : réglages par jeu pour la seule série+CRC connue, jamais écrasés ; série et CRC lus sur le disque', async () => {
    const table = { 'SLES-52541': { EmuCore: { InputProfileName: 'RomVault Clavier' } } }
    await applyPcsx2Game(dir, { serial: 'SLUS-00001', crc: '11111111' }, table)
    expect(existsSync(join(dir, 'gamesettings'))).toBe(false)
    await applyPcsx2Game(dir, { serial: 'SLES-52541', crc: 'B440A8FE' }, table)
    expect(read('gamesettings', 'SLES-52541_B440A8FE.ini')).toContain('InputProfileName = RomVault Clavier')
    writeFileSync(join(dir, 'gamesettings', 'SLES-52541_B440A8FE.ini'), 'perso')
    await applyPcsx2Game(dir, { serial: 'SLES-52541', crc: 'B440A8FE' }, table)
    expect(read('gamesettings', 'SLES-52541_B440A8FE.ini')).toBe('perso')
    expect(ps2SerialFromBoot('cdrom0:\\SLES_525.41;1')).toBe('SLES-52541')
    expect(ps2ElfCrc(Buffer.from('1111111122222222', 'hex'))).toBe('33333333')
    // Image ISO 9660 minimale : SYSTEM.CNF (BOOT2) et un exécutable de deux mots à la racine.
    const iso = Buffer.alloc(2048 * 22)
    iso.write('CD001', 16 * 2048 + 1, 'latin1')
    iso.writeUInt32LE(18, 16 * 2048 + 156 + 2); iso.writeUInt32LE(2048, 16 * 2048 + 156 + 10)
    const cnf = 'BOOT2 = cdrom0:\\SLES_525.41;1\r\nVER = 2.01\r\n'
    const records: [string, number, number][] = [['SYSTEM.CNF;1', 19, cnf.length], ['SLES_525.41;1', 20, 8]]
    let at = 18 * 2048
    for (const [name, lba, size] of records) {
      const len = 34 + name.length + (name.length % 2 === 0 ? 1 : 0)
      iso[at] = len; iso.writeUInt32LE(lba, at + 2); iso.writeUInt32LE(size, at + 10); iso[at + 32] = name.length; iso.write(name, at + 33, 'latin1')
      at += len
    }
    iso.write(cnf, 19 * 2048, 'latin1')
    Buffer.from('0F0F0F0FF0F0F0F0', 'hex').copy(iso, 20 * 2048)
    writeFileSync(join(dir, 'jeu.iso'), iso)
    expect(await readPs2Game(join(dir, 'jeu.iso'))).toEqual({ serial: 'SLES-52541', crc: 'FFFFFFFF' })
    expect(await readPs2Game(join(dir, 'jeu.chd'))).toBeNull()
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
    // Réduit les temps de lancement/chargement (plus sensible sur Wii) ; désactivé au cas par cas pour les rares jeux qui en dépendent (voir applyDolphinFastDiscExclusion).
    expect(ini).toContain('FastDiscSpeed = true')
    expect(read('User', 'Config', 'GFX.ini')).toContain('InternalResolution = 3')
    expect(ini).toContain('GFXBackend = Vulkan')
    expect(ini).toContain('Backend = Cubeb')
    expect(ini).toContain('Volume = 100')
    expect(ini).not.toContain('AudioLatency')
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
  it('Dolphin : une manette GameCube ne touche pas la Wiimote, et inversement', async () => {
    await configureEmulator('dolphin', dir, ctx())
    const wii = read('User', 'Config', 'WiimoteNew.ini')
    await applyDolphinPad(dir, 0, { console: 'gc', gameId: 'GALE01' })
    expect(read('User', 'Config', 'GCPadNew.ini')).toContain('XInput/0/Gamepad:Button A')
    expect(read('User', 'Config', 'WiimoteNew.ini')).toBe(wii)
    const gc = read('User', 'Config', 'GCPadNew.ini')
    await applyDolphinPad(dir, 2, { console: 'wii', gameId: 'RSBE01' })
    expect(read('User', 'Config', 'GCPadNew.ini')).toBe(gc)
    const w = read('User', 'Config', 'WiimoteNew.ini')
    expect(w).toContain('Extension = Classic')
    expect(w).toContain('Classic/Buttons/A = `X` | `XInput/2/Gamepad:Button B`')
    expect(w).not.toContain('Nunchuk/')
  })
  it('Dolphin : Wii classique -> Nunchuk, jeu de mouvement -> balayages ; profil modifié à la main jamais réécrit', async () => {
    await configureEmulator('dolphin', dir, ctx())
    await applyDolphinPad(dir, 0, { console: 'wii', gameId: 'RSPE01' })
    const motion = read('User', 'Config', 'WiimoteNew.ini')
    expect(motion).toContain('Extension = Nunchuk')
    expect(motion).toContain('Swing/Up = `I` | `XInput/0/Gamepad:Right Y+`')
    expect(motion).toContain('IR/Up = `Cursor Y-`\n')
    await applyDolphinPad(dir, 0, { console: 'wii', gameId: 'RMGE01' })
    const nunchuk = read('User', 'Config', 'WiimoteNew.ini')
    expect(nunchuk).not.toContain('Swing/')
    expect(nunchuk).toContain('IR/Up = `XInput/0/Gamepad:Right Y+`')
    expect(nunchuk).toContain('IR/Relative Input = True')
    expect(nunchuk).toContain('Buttons/A = `Click 0` | `XInput/0/Gamepad:Button B` | `XInput/0/Gamepad:Shoulder L`')
    expect(nunchuk).toContain('Shake/X = `Click 2` | `XInput/0/Gamepad:Button X`')
    expect(nunchuk).toContain('Tilt/Forward = `XInput/0/Gamepad:Trigger L`&`XInput/0/Gamepad:Left Y+`')
    expect(nunchuk).toContain('Nunchuk/Buttons/Z = `Ctrl` | `XInput/0/Gamepad:Trigger R`')
    expect(nunchuk).toContain('Buttons/Home = RETURN\n')
    expect(nunchuk).toContain('Buttons/- = Q | `XInput/0/Gamepad:Start`\n')
    expect(nunchuk).toContain('Hotkeys/Upright Hold = `XInput/0/Gamepad:Trigger L`')
    writeFileSync(join(dir, 'User', 'Config', 'WiimoteNew.ini'), '[Wiimote1]\nSource = 2\nButtons/A = `Button A`\n')
    await applyDolphinPad(dir, 0, { console: 'wii', gameId: 'RSBE01' })
    expect(read('User', 'Config', 'WiimoteNew.ini')).toContain('Source = 2')
    expect(isUntouchedWiimoteFile('[Wiimote1]\nButtons/A = `Click 0` | `XInput/0/Gamepad:Button A`\n')).toBe(true)
  })
  it('Dolphin : OpenGL sans Vulkan, résolution bridée sur iGPU, jamais plus haute que l’écran', async () => {
    await configureEmulator('dolphin', dir, ctx({ displayHeight: 2160, gpu: { vulkan: false, tier: 'igpu' } }))
    expect(read('User', 'Config', 'Dolphin.ini')).toContain('GFXBackend = OGL')
    const gfx = read('User', 'Config', 'GFX.ini')
    expect(gfx).toContain('InternalResolution = 2')
    expect(gfx).not.toContain('ShaderCompilationMode')
    expect(dolphinScale({ vulkan: true, tier: 'high' }, 2160)).toBe(6)
    expect(dolphinScale({ vulkan: true, tier: 'high' }, 1440)).toBe(4)
    expect(dolphinScale({ vulkan: true, tier: 'mid' }, 768)).toBe(2)
    expect(dolphinScale({ vulkan: true, tier: 'mid' }, 1080)).toBe(3)
  })
  it('Dolphin : FastDiscSpeed désactivé seulement pour un jeu de la liste d’exclusion connue (aucun pour l’instant), sans toucher aux autres jeux', async () => {
    // Liste vide par défaut (voir DOLPHIN_FAST_DISC_EXCLUSIONS) : rien n'est écrit sans `force`.
    await applyDolphinFastDiscExclusion(dir, 'GALE01')
    expect(existsSync(join(dir, 'User', 'GameSettings', 'GALE01.ini'))).toBe(false)
    // `force` (détection automatique d'un plantage, voir launcher.ts) contourne la liste.
    await applyDolphinFastDiscExclusion(dir, 'GFTE01', true)
    expect(read('User', 'GameSettings', 'GFTE01.ini')).toBe('[Core]\nFastDiscSpeed = false\n')
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
    expect(cfg).toContain('video_driver = "vulkan"')
    expect(cfg).toContain('video_shader_enable = "false"')
    expect(cfg).toContain('audio_driver = "wasapi"')
    expect(cfg).toContain('audio_device = ""')
    expect(cfg).toContain('audio_wasapi_exclusive_mode = "false"')
    expect(cfg).not.toContain('audio_latency')
    // Les réglages du cœur N64 vivent dans config/<cœur>/ (RetroArch ne lit pas de fichier d'options global).
    expect(read('config', 'Mupen64Plus-Next', 'Mupen64Plus-Next.opt')).toContain('mupen64plus-next-EnableNativeResFactor = "4"')
    expect(read('config', 'Mupen64Plus-Next', 'Mupen64Plus-Next.cfg')).toContain('video_driver = "glcore"')
    expect(existsSync(join(dir, 'retroarch-core-options.cfg'))).toBe(false)
  })
  it('RetroArch : OpenGL sans Vulkan, résolution N64 bridée par le GPU et suivant l’écran', async () => {
    await configureEmulator('retroarch', dir, ctx({ displayHeight: 2160, gpu: { vulkan: false, tier: 'igpu' } }))
    expect(read('retroarch.cfg')).toContain('video_driver = "gl"')
    expect(read('config', 'Mupen64Plus-Next', 'Mupen64Plus-Next.cfg')).toContain('video_driver = "gl"')
    expect(read('config', 'Mupen64Plus-Next', 'Mupen64Plus-Next.opt')).toContain('EnableNativeResFactor = "2"')
    expect(n64Factor({ vulkan: true, tier: 'high' }, 3)).toBe(8)
    expect(n64Factor({ vulkan: true, tier: 'mid' }, 3)).toBe(6)
    expect(n64Factor({ vulkan: true, tier: 'low' }, 1)).toBe(3)
  })
  it('RetroArch : une option de cœur déjà réglée par l’utilisateur est conservée (fusion)', async () => {
    mkdirSync(join(dir, 'config', 'Mupen64Plus-Next'), { recursive: true })
    writeFileSync(join(dir, 'config', 'Mupen64Plus-Next', 'Mupen64Plus-Next.opt'), 'mupen64plus-next-aspect = "16:9"'+'\n')
    await configureEmulator('retroarch', dir, ctx())
    expect(read('config', 'Mupen64Plus-Next', 'Mupen64Plus-Next.opt')).toContain('mupen64plus-next-aspect = "16:9"')
  })
  it('les fichiers YAML/XML des émulateurs à réglage unique ne sont jamais réécrits', async () => {
    writeFileSync(join(dir, 'config.yml'), 'mine: 1\n')
    await configureEmulator('rpcs3', dir, ctx())
    expect(read('config.yml')).toBe('mine: 1\n')
  })
  it('RPCS3 : Vulkan sur le GPU détecté, résolution selon l’écran, langue ; jamais réécrit', async () => {
    await configureEmulator('rpcs3', dir, ctx({ gpu: { vulkan: true, tier: 'high', name: 'NVIDIA GeForce RTX 3060' } }))
    const t = read('config', 'config.yml')
    expect(t).toContain('Renderer: Vulkan')
    expect(t).toContain('Resolution Scale: 150')
    expect(t).toContain('Resolution: 1920x1080')
    expect(t).toContain('Adapter: "NVIDIA GeForce RTX 3060"')
    expect(t).toContain('Language: French')
    expect(t).not.toMatch(/Aspect|Audio|Master Volume|Shader/)
    writeFileSync(join(dir, 'config', 'config.yml'), 'Video:\n  Resolution Scale: 200\n')
    await configureEmulator('rpcs3', dir, ctx())
    expect(read('config', 'config.yml')).toBe('Video:\n  Resolution Scale: 200\n')
  })
  it('RPCS3 : OpenGL sans Vulkan, résolution bornée sur iGPU', () => {
    const t = rpcs3ConfigYaml({ vulkan: false, tier: 'igpu', name: 'Intel(R) HD Graphics 4600' }, 2160, false)
    expect(t).toContain('Renderer: OpenGL')
    expect(t).toContain('Resolution Scale: 100')
    expect(t).not.toContain('Adapter')
    expect(rpcs3Scale({ vulkan: true, tier: 'high' }, 1440)).toBe(200)
    expect(rpcs3Scale({ vulkan: true, tier: 'high' }, 2160)).toBe(300)
    expect(rpcs3Scale({ vulkan: true, tier: 'low' }, 1080)).toBe(150)
  })
  it('RPCS3 : profil de manette XInput à l’emplacement réel, Sony natif, clavier ; un profil réglé par l’utilisateur jamais touché', async () => {
    const file = join(dir, 'config', 'input_configs', 'global', 'Default.yml')
    // Sans profil RPCS3 n'utilise aucune manette : on écrit le profil XInput (emplacement 1 = « XInput Pad #2 »), mapping Xbox → PlayStation.
    await applyRpcs3Pad(dir, { kind: 'xinput', slot: 1 })
    const t = readFileSync(file, 'utf8')
    expect(t.startsWith('# romvault:rpcs3-input')).toBe(true)
    expect(t).toContain('Handler: XInput')
    expect(t).toContain('Device: "XInput Pad #2"')
    expect(t).toContain('Cross: A')
    expect(t).toContain('Square: X')
    expect(t).toContain('L2: LT')
    expect(t).toContain('Left Stick Up: LS Y+')
    await applyRpcs3Pad(dir, { kind: 'dualsense' })
    expect(readFileSync(file, 'utf8')).toContain('Handler: DualSense')
    // Plus de manette : le profil de RomVault est retiré, RPCS3 retombe sur son pad clavier par défaut.
    await applyRpcs3Pad(dir, null)
    expect(existsSync(file)).toBe(false)
    // Profil modifié dans RPCS3 (marqueur disparu) : jamais écrasé ni supprimé.
    mkdirSync(join(dir, 'config', 'input_configs', 'global'), { recursive: true })
    writeFileSync(file, 'Player 1 Input:\n  Handler: SDL\n')
    await applyRpcs3Pad(dir, { kind: 'xinput', slot: 0 })
    await applyRpcs3Pad(dir, null)
    expect(readFileSync(file, 'utf8')).toBe('Player 1 Input:\n  Handler: SDL\n')
  })
  it('RPCS3 : réglages par jeu pour le seul numéro de série connu, jamais écrasés ; série lue dans PARAM.SFO', async () => {
    const table = { BLES01179: { config: 'Video:\n  Resolution Scale: 100\n', input: rpcs3InputYaml('xinput') } }
    await applyRpcs3Game(dir, 'NPUB30000', table)
    expect(existsSync(join(dir, 'config', 'custom_configs'))).toBe(false)
    await applyRpcs3Game(dir, 'bles01179', table)
    expect(read('config', 'custom_configs', 'config_BLES01179.yml')).toContain('Resolution Scale: 100')
    expect(read('config', 'input_configs', 'BLES01179', 'Default.yml')).toContain('Handler: XInput')
    writeFileSync(join(dir, 'config', 'custom_configs', 'config_BLES01179.yml'), 'perso')
    await applyRpcs3Game(dir, 'BLES01179', table)
    expect(read('config', 'custom_configs', 'config_BLES01179.yml')).toBe('perso')
    // PARAM.SFO minimal : une entrée TITLE_ID.
    const sfo = Buffer.alloc(80)
    sfo.writeUInt32LE(0x46535000, 0); sfo.writeUInt32LE(0x1010000, 4)
    sfo.writeUInt32LE(40, 8); sfo.writeUInt32LE(56, 12); sfo.writeUInt32LE(1, 16)
    sfo.writeUInt16LE(0, 20); sfo.writeUInt16LE(0x204, 22); sfo.writeUInt32LE(10, 24); sfo.writeUInt32LE(16, 28); sfo.writeUInt32LE(0, 32)
    sfo.write('TITLE_ID', 40, 'latin1'); sfo.write('BLES01179', 56, 'latin1')
    expect(sfoString(sfo, 'TITLE_ID')).toBe('BLES01179')
    // Image ISO 9660 minimale : dossier PS3_GAME contenant PARAM.SFO.
    const iso = Buffer.alloc(2048 * 22)
    iso.write('CD001', 16 * 2048 + 1, 'latin1')
    iso.writeUInt32LE(18, 16 * 2048 + 156 + 2); iso.writeUInt32LE(2048, 16 * 2048 + 156 + 10)
    const rec = (at: number, name: string, lba: number, size: number, flags: number): void => {
      iso[at] = 34 + name.length + (name.length % 2 === 0 ? 1 : 0); iso[at + 25] = flags; iso.writeUInt32LE(lba, at + 2); iso.writeUInt32LE(size, at + 10); iso[at + 32] = name.length; iso.write(name, at + 33, 'latin1')
    }
    rec(18 * 2048, 'PS3_GAME', 19, 2048, 2)
    rec(19 * 2048, 'PARAM.SFO;1', 20, 80, 0)
    sfo.copy(iso, 20 * 2048)
    writeFileSync(join(dir, 'jeu.iso'), iso)
    expect(await readPs3Serial(join(dir, 'jeu.iso'))).toBe('BLES01179')
    expect(await readPs3Serial(join(dir, 'jeu.pkg'))).toBeNull()
  })
  it('RPCS3 : plein écran et boîtes de confirmation de démarrage/fermeture désactivées', async () => {
    await configureEmulator('rpcs3', dir, ctx())
    const ini = read('GuiConfigs', 'CurrentSettings.ini')
    expect(ini).toContain('infoBoxEnabledWelcome=false')
    expect(ini).toContain('startGameFullscreen=true')
    expect(ini).toContain('confirmationBoxBootGame=false')
    expect(ini).toContain('confirmationBoxExitGame=false')
  })
  it('PPSSPP : confirmation de fermeture désactivée', async () => {
    await configureEmulator('ppsspp', dir, ctx())
    expect(read('memstick', 'PSP', 'SYSTEM', 'ppsspp.ini')).toContain('AskForExitConfirmationAfterSeconds = 0')
  })
  it('PPSSPP : Vulkan sur le GPU détecté, résolution entière selon l’écran et le GPU, audio et manettes laissés aux défauts ; réglages existants gardés', async () => {
    await configureEmulator('ppsspp', dir, ctx({ gpu: { vulkan: true, tier: 'high', name: 'NVIDIA GeForce RTX 3060' } }))
    const ini = read('memstick', 'PSP', 'SYSTEM', 'ppsspp.ini')
    expect(ini).toContain('GraphicsBackend = 3 (VULKAN)')
    expect(ini).toContain('VulkanDevice = NVIDIA GeForce RTX 3060')
    expect(ini).toContain('InternalResolution = 4')
    expect(ini).not.toMatch(/Sound|GameVolume|AudioDevice|TexScaling|controls/i)
    expect(existsSync(join(dir, 'memstick', 'PSP', 'SYSTEM', 'controls.ini'))).toBe(false)
  })
  it('PPSSPP : Direct3D 11 sans Vulkan, résolution bornée sur iGPU et selon l’écran', () => {
    expect(ppssppGraphics({ vulkan: false, tier: 'igpu' }, 2160)).toMatchObject({ GraphicsBackend: '2 (DIRECT3D11)', InternalResolution: 2 })
    expect(ppssppGraphics({ vulkan: false, tier: 'igpu' }, 2160)).not.toHaveProperty('VulkanDevice')
    expect(ppssppScale({ vulkan: true, tier: 'high' }, 1440)).toBe(6)
    expect(ppssppScale({ vulkan: true, tier: 'high' }, 2160)).toBe(8)
    expect(ppssppScale({ vulkan: true, tier: 'low' }, 2160)).toBe(4)
    expect(ppssppScale({ vulkan: true, tier: 'mid' }, 720)).toBe(3)
  })
  it('PPSSPP : réglages par jeu pour le seul DISC_ID connu, jamais écrasés ; DISC_ID lu dans PARAM.SFO de l’ISO', async () => {
    const table = { UCES00842: { Graphics: { InternalResolution: 2 } } }
    const file = join(dir, 'memstick', 'PSP', 'SYSTEM', 'UCES00842_ppsspp.ini')
    await applyPpssppGame(dir, 'ULES01474', table)
    expect(existsSync(join(dir, 'memstick'))).toBe(false)
    await applyPpssppGame(dir, 'uces00842', table)
    expect(readFileSync(file, 'utf8')).toContain('InternalResolution = 2')
    writeFileSync(file, 'perso')
    await applyPpssppGame(dir, 'UCES00842', table)
    expect(readFileSync(file, 'utf8')).toBe('perso')
    // ISO 9660 minimale : dossier PSP_GAME contenant PARAM.SFO (une entrée DISC_ID).
    const sfo = Buffer.alloc(80)
    sfo.writeUInt32LE(0x46535000, 0); sfo.writeUInt32LE(0x1010000, 4)
    sfo.writeUInt32LE(40, 8); sfo.writeUInt32LE(56, 12); sfo.writeUInt32LE(1, 16)
    sfo.writeUInt16LE(0, 20); sfo.writeUInt16LE(0x204, 22); sfo.writeUInt32LE(10, 24); sfo.writeUInt32LE(16, 28); sfo.writeUInt32LE(0, 32)
    sfo.write('DISC_ID', 40, 'latin1'); sfo.write('UCES00842', 56, 'latin1')
    const iso = Buffer.alloc(2048 * 22)
    iso.write('CD001', 16 * 2048 + 1, 'latin1')
    iso.writeUInt32LE(18, 16 * 2048 + 156 + 2); iso.writeUInt32LE(2048, 16 * 2048 + 156 + 10)
    const rec = (at: number, name: string, lba: number, size: number, flags: number): void => {
      iso[at] = 34 + name.length + (name.length % 2 === 0 ? 1 : 0); iso[at + 25] = flags; iso.writeUInt32LE(lba, at + 2); iso.writeUInt32LE(size, at + 10); iso[at + 32] = name.length; iso.write(name, at + 33, 'latin1')
    }
    rec(18 * 2048, 'PSP_GAME', 19, 2048, 2)
    rec(19 * 2048, 'PARAM.SFO;1', 20, 80, 0)
    sfo.copy(iso, 20 * 2048)
    writeFileSync(join(dir, 'jeu.iso'), iso)
    expect(await readPspDiscId(join(dir, 'jeu.iso'))).toBe('UCES00842')
    expect(await readPspDiscId(join(dir, 'jeu.cso'))).toBeNull()
  })
  it('Vita3K : bienvenue et avertissement firmware manquant désactivés (config.yml déjà présent, pas besoin de lancer l’exe)', async () => {
    writeFileSync(join(dir, 'config.yml'), 'sys-lang: 1\nshow-welcome: true\nwarn-missing-firmware: true\nconfirm_exit_app: true\n')
    await configureEmulator('vita3k', dir, ctx())
    const yml = read('config.yml')
    expect(yml).toContain('show-welcome: false')
    // Sans ça, Vita3K bloque l'auto-boot d'un jeu derrière une boîte de dialogue jamais fermée (assistant BIOS = firmware de base seul, jamais les polices).
    expect(yml).toContain('warn-missing-firmware: false')
    expect(yml).toContain('check-for-updates-mode: 0')
  })
  it('Vita3K : Vulkan (OpenGL en repli), résolution entière selon l’écran et le GPU ; réglages existants gardés', async () => {
    writeFileSync(join(dir, 'config.yml'), 'backend-renderer: Vulkan\nresolution-multiplier: 2\nv-sync: false\n')
    await configureEmulator('vita3k', dir, ctx({ gpu: { vulkan: true, tier: 'high' }, displayHeight: 1440 }))
    expect(read('config.yml')).toMatch(/resolution-multiplier: 3/)
    expect(read('config.yml')).toContain('v-sync: false')
    writeFileSync(join(dir, 'config.yml'), 'backend-renderer: Vulkan\nresolution-multiplier: 2\n')
    await configureEmulator('vita3k', dir, ctx({ gpu: { vulkan: false, tier: 'igpu' }, displayHeight: 2160 }))
    expect(read('config.yml')).toContain('backend-renderer: OpenGL')
    expect(read('config.yml')).toContain('resolution-multiplier: 1')
    expect(vita3kScale({ vulkan: true, tier: 'high' }, 1080)).toBe(2)
    expect(vita3kScale({ vulkan: true, tier: 'high' }, 2160)).toBe(4)
    expect(vita3kScale({ vulkan: true, tier: 'low' }, 2160)).toBe(2)
  })
  it('Vita3K : confirmation de fermeture Qt désactivée (fichier ini séparé de config.yml)', async () => {
    await configureEmulator('vita3k', dir, ctx())
    // La vraie boîte « Exit App? » constatée en vrai est un réglage Qt (gui-qt/src/game_window.cpp), pas config.yml.
    expect(read('gui-configs', 'CurrentSettings.ini')).toMatch(/^confirmExitApp=false/m)
  })
  it('melonDS : un melonDS.toml déjà présent (lancement manuel avant l’installation par RomVault) est complété, pas ignoré', async () => {
    writeFileSync(join(dir, 'melonDS.toml'), 'mine = 1\n')
    await configureEmulator('melonds', dir, ctx())
    const t = read('melonDS.toml')
    expect(t).toContain('mine = 1')
    expect(t).toContain('[3D]\nRenderer = 2')
    expect(t).toContain('[Instance0.Firmware]')
    expect(t).toContain('OverrideSettings = true')
    expect(t).toContain('Language = 2')
  })
  it('melonDS : clavier lié (schéma IJKL/flèches), langue, résolution, sans écraser le reste', async () => {
    await configureEmulator('melonds', dir, ctx({ lang: 'en', displayHeight: 2160 }))
    const t = read('melonDS.toml')
    expect(t).toContain('ScaleFactor = 8')
    expect(t).toContain('Language = 1')
    expect(t).toContain('[Instance0.Keyboard]')
    expect(t).toContain('A = 76')
    expect(t).toContain('Up = 16777235')
    // Une 2e configuration ne perd pas ce qu'une 1re a écrit.
    await configureEmulator('melonds', dir, ctx({ lang: 'en', displayHeight: 2160 }))
    expect(read('melonDS.toml')).toContain('[3D]\nRenderer = 2')
  })
  it('melonDS : OpenGL à l’échelle de l’écran, Natural + Auto, pixels nets, audio 100 %, manette et raccourcis', async () => {
    await configureEmulator('melonds', dir, ctx({ gpu: { vulkan: true, tier: 'high' } }))
    const t = read('melonDS.toml')
    expect(t).toContain('[3D]\nRenderer = 2')
    expect(t).toContain('ScaleFactor = 6')
    expect(t).toContain('UseGL = true')
    expect(t).toContain('Threaded = true')
    const win = tomlSection(t, 'Instance0.Window0')
    expect(win).toMatchObject({ ScreenLayout: '0', ScreenSizing: '3', ScreenGap: '8', ScreenFilter: 'false', IntegerScaling: 'false', ScreenRotation: '0' })
    expect(tomlSection(t, 'Instance0.Audio').Volume).toBe('256')
    // Manette : indices SDL XInput, DS positionnelle (A à droite = bouton B), croix = hat 0.
    const pad = tomlSection(t, 'Instance0.Joystick')
    expect(pad).toMatchObject({ A: '1', B: '0', X: '3', Y: '2', L: '69271556', R: '86048773', Select: '6', Start: '7', Up: '17891585', Right: '65794', Down: '16843012', Left: '1114376', HK_SwapScreens: '9' })
    expect(tomlSection(t, 'Instance0.Keyboard')).toMatchObject({ A: '76', HK_SwapScreens: '32', HK_FullscreenToggle: '16777274' })
    // Aucune liaison de souris ni de tactile : le stylet est le comportement natif de melonDS.
    expect(t).not.toMatch(/Touch/i)
  })
  it('melonDS : rendu logiciel threadé sans pilote moderne, facteur borné par le GPU', async () => {
    await configureEmulator('melonds', dir, ctx({ displayHeight: 2160, gpu: { vulkan: false, tier: 'igpu' } }))
    const t = read('melonDS.toml')
    expect(t).toContain('[3D]\nRenderer = 0')
    expect(t).toContain('UseGL = false')
    expect(t).toContain('ScaleFactor = 3')
    expect(melondsRendering({ vulkan: true, tier: 'mid' }, 1440).scale).toBe(8)
    expect(melondsRendering({ vulkan: true, tier: 'igpu' }, 1080).renderer).toBe(1)
    expect(melondsRendering({ vulkan: true, tier: 'low' }, 1080).renderer).toBe(2)
    expect(melondsRendering({ vulkan: true, tier: 'mid' }, 2160).scale).toBe(8)
    expect(melondsRendering({ vulkan: true, tier: 'high' }, 2160).scale).toBe(11)
    expect(melondsRendering({ vulkan: true, tier: 'low' }, 1080).scale).toBe(4)
  })
  it('melonDS : un mapping déjà choisi par l’utilisateur est conservé tant que RomVault ne réinstalle pas', async () => {
    writeFileSync(join(dir, 'melonDS.toml'), '[Instance0.Joystick]\nA = 7\n')
    await applyMelondsGame(dir, 'ABCD', {})
    expect(read('melonDS.toml')).toBe('[Instance0.Joystick]\nA = 7\n')
  })
  it('melonDS : disposition par jeu appliquée puis restaurée, une valeur changée à la main n’est jamais restaurée', async () => {
    await configureEmulator('melonds', dir, ctx())
    const table = { HOTL: { ScreenLayout: 2, ScreenRotation: 1 } }
    await applyMelondsGame(dir, 'HOTL', table)
    expect(tomlSection(read('melonDS.toml'), 'Instance0.Window0')).toMatchObject({ ScreenLayout: '2', ScreenRotation: '1' })
    // Autre jeu : retour à Natural / 0°.
    await applyMelondsGame(dir, 'ZZZZ', table)
    expect(tomlSection(read('melonDS.toml'), 'Instance0.Window0')).toMatchObject({ ScreenLayout: '0', ScreenRotation: '0' })
    expect(existsSync(join(dir, 'romvault-melonds-layout.json'))).toBe(false)
    // L'utilisateur change la disposition pendant la partie : elle est gardée au lancement suivant.
    await applyMelondsGame(dir, 'HOTL', table)
    const toml = read('melonDS.toml').replace('ScreenLayout = 2', 'ScreenLayout = 3')
    writeFileSync(join(dir, 'melonDS.toml'), toml)
    await applyMelondsGame(dir, 'ZZZZ', table)
    expect(tomlSection(read('melonDS.toml'), 'Instance0.Window0')).toMatchObject({ ScreenLayout: '3', ScreenRotation: '0' })
    expect(ndsGameCode(Buffer.concat([Buffer.alloc(12), Buffer.from('ADMJ'), Buffer.alloc(8)]))).toBe('ADMJ')
    expect(ndsGameCode(Buffer.alloc(32))).toBeNull()
  })
  it('melonDS : [Instance0] est écrit en table explicite avant ses sous-tables, sinon melonDS plante au 1er lancement (toml::serializer implicit table)', async () => {
    await configureEmulator('melonds', dir, ctx())
    const t = read('melonDS.toml')
    expect(t).toContain('[Instance0]')
    expect(t.indexOf('[Instance0]\n')).toBeLessThan(t.indexOf('[Instance0.Firmware]'))
    expect(t.indexOf('[Instance0]\n')).toBeLessThan(t.indexOf('[Instance0.Keyboard]'))
  })
  it('Azahar : Vulkan, shaders matériels/JIT/cache/asynchrones, résolution selon l’écran, layout Large Screen, audio système, clavier actif à l’installation', async () => {
    await configureEmulator('azahar', dir, ctx({ gpu: { vulkan: true, tier: 'high' } }))
    const t = read('user', 'config', 'qt-config.ini')
    expect(t).toContain('fullscreen=true')
    expect(t).toContain('language=fr')
    // Sans ça, un « Fermer le jeu » de RomVault ouvre la boîte de confirmation d'Azahar plutôt que de fermer.
    expect(t).toContain('confirmClose=false')
    expect(t).toContain('graphics_api=2')
    expect(t).toContain('use_hw_shader=true')
    expect(t).toContain('use_shader_jit=true')
    expect(t).toContain('use_disk_shader_cache=true')
    expect(t).toContain('async_shader_compilation=true')
    expect(t).toContain('resolution_factor=5')
    expect(t).toContain('layout_option=2')
    expect(t).toContain('output_device=Auto')
    expect(t).toContain('volume=1')
    // Clavier d'Azahar (profil 1, index 0) actif tant qu'aucune manette n'est branchée ; profil manette présent, souris = tactile et mouvement émulé.
    expect(t).toContain('profile=0')
    expect(t).toContain('profiles\\size=2')
    expect(t).toContain('profiles\\2\\name=Manette')
    expect(t).toMatch(/profiles\\2\\circle_pad="api:controller,axis_x:0,axis_y:1,deadzone:0\.100000,engine:sdl,guid:78696e70757401000000000000000000,maptype:all,port:0"/)
    expect(t).toContain('profiles\\2\\touch_device=engine:emu_window')
    expect(t).toContain('profiles\\2\\motion_device=\"engine:motion_emu')
    // Raccourcis manette natifs : clic du stick droit + bas = échanger les écrans.
    expect(t).toMatch(/Swap%20Screens\\controller_keyseq="api:controller,button:8,engine:sdl,[^"|]*"/)
    expect(t).not.toContain('Toggle%20Screen%20Layout\\controller_keyseq=')
    // Liaisons à l'API controller + « toutes les manettes » : sans ça Azahar exige le GUID exact et aucune manette réelle ne répond.
    expect(t).toContain('profiles\\2\\input_maptype=0')
    expect(t).toMatch(/profiles\\2\\button_a="api:controller,button:1,/)
    // LB/RB = tap sur l'écran tactile (320x240) : milieu en hauteur, à 1/3 depuis la gauche (LB, bouton SDL 9) et depuis la droite (RB, bouton SDL 10) ; la souris reste.
    expect(t).toContain('profiles\\2\\use_touch_from_button=true')
    expect(t).toContain('profiles\\2\\touch_device=engine:emu_window')
    expect(t).toMatch(/touch_from_button_maps\\1\\entries\\1\\bind="api:controller,button:9,[^"]*,x:107,y:120"/)
    expect(t).toMatch(/touch_from_button_maps\\1\\entries\\2\\bind="api:controller,button:10,[^"]*,x:213,y:120"/)
    expect(t).toContain('touch_from_button_maps\\1\\entries\\size=2')
    // LT → L + ZL, RT → R + ZR : le même axe de gâchette sur deux boutons 3DS (axes SDL 4 = LT, 5 = RT).
    for (const [btn, axis] of [['l', 4], ['zl', 4], ['r', 5], ['zr', 5]] as const) expect(t).toMatch(new RegExp(`profiles\\\\2\\\\button_${btn}="api:controller,axis:${axis},direction:\\+,`))
  })
  it('Azahar : OpenGL sans Vulkan, résolution bornée sur iGPU et suivant l’écran', async () => {
    await configureEmulator('azahar', dir, ctx({ displayHeight: 2160, gpu: { vulkan: false, tier: 'igpu' } }))
    const t = read('user', 'config', 'qt-config.ini')
    expect(t).toContain('graphics_api=1')
    expect(t).toContain('resolution_factor=2')
    expect(azaharScale({ vulkan: true, tier: 'high' }, 1080)).toBe(5)
    expect(azaharScale({ vulkan: true, tier: 'high' }, 1440)).toBe(6)
    expect(azaharScale({ vulkan: true, tier: 'high' }, 2160)).toBe(9)
    expect(azaharScale({ vulkan: true, tier: 'low' }, 1080)).toBe(3)
  })
  it('Azahar : profil clavier ou manette selon ce qui est branché, un autre profil choisi par l’utilisateur n’est jamais touché', async () => {
    await configureEmulator('azahar', dir, ctx())
    await applyAzaharPad(dir, true)
    expect(read('user', 'config', 'qt-config.ini')).toMatch(/^profile=1$/m)
    await applyAzaharPad(dir, false)
    expect(read('user', 'config', 'qt-config.ini')).toMatch(/^profile=0$/m)
    const file = join(dir, 'user', 'config', 'qt-config.ini')
    writeFileSync(file, read('user', 'config', 'qt-config.ini').replace(/^profile=0$/m, 'profile=2'))
    await applyAzaharPad(dir, true)
    expect(read('user', 'config', 'qt-config.ini')).toMatch(/^profile=2$/m)
  })
  it('Azahar : un profil manette écrit par une ancienne version (sans api:controller) est réparé au lancement, un profil refait par l’utilisateur jamais', async () => {
    await configureEmulator('azahar', dir, ctx())
    const file = join(dir, 'user', 'config', 'qt-config.ini')
    const fresh = read('user', 'config', 'qt-config.ini')
    // Ancien format, tel qu'Azahar l'avait réécrit : par GUID, sans api:controller.
    const old = fresh
      .replace(/profiles\\2\\button_a="api:controller,button:1,engine:sdl,guid:(\w+),maptype:all,port:0"/, 'profiles\\2\\button_a="button:1,engine:sdl,guid:$1,maptype:guid,port:0"')
      .replace('profiles\\2\\input_maptype=0', 'profiles\\2\\input_maptype=1')
    expect(old).not.toBe(fresh)
    writeFileSync(file, old)
    await applyAzaharPad(dir, true)
    const t = read('user', 'config', 'qt-config.ini')
    expect(t).toMatch(/profiles\\2\\button_a="api:controller,button:1,engine:sdl,guid:\w+,maptype:all,port:0"/)
    expect(t).toContain('profiles\\2\\input_maptype=0')
    expect(t).toMatch(/^profile=1$/m)
    // Profil refait dans Azahar (autre GUID, pas notre signature) : intact.
    const mine = fresh.replace(/profiles\\2\\button_a="[^"]*"/, 'profiles\\2\\button_a="api:controller,button:0,engine:sdl,guid:030000005e040000ff02000000007200,maptype:guid,port:0"')
    writeFileSync(file, mine)
    await applyAzaharPad(dir, false)
    expect(read('user', 'config', 'qt-config.ini')).toBe(mine)
  })
  it('Azahar : le tactile par bouton est ajouté à une installation d’avant (carte vide), jamais par-dessus la carte de l’utilisateur', async () => {
    await configureEmulator('azahar', dir, ctx())
    const file = join(dir, 'user', 'config', 'qt-config.ini')
    const fresh = read('user', 'config', 'qt-config.ini')
    const stripped = fresh
      .replace(/^touch_from_button_maps\\1\\entries\\[12]\\bind=.*\r?\n/gm, '')
      .replace('touch_from_button_maps\\1\\entries\\size=2', 'touch_from_button_maps\\1\\entries\\size=0')
      .replace('profiles\\2\\use_touch_from_button=true', 'profiles\\2\\use_touch_from_button=false')
    expect(stripped).not.toBe(fresh)
    writeFileSync(file, stripped)
    await applyAzaharPad(dir, true)
    const t = read('user', 'config', 'qt-config.ini')
    expect(t).toContain('profiles\\2\\use_touch_from_button=true')
    expect(t).toMatch(/entries\\1\\bind="api:controller,button:9,[^"]*,x:107,y:120"/)
    // Carte déjà remplie par l'utilisateur : on n'y touche pas.
    const mine = stripped.replace('touch_from_button_maps\\1\\entries\\size=0', 'touch_from_button_maps\\1\\entries\\size=1\ntouch_from_button_maps\\1\\entries\\1\\bind="engine:keyboard,code:65,x:10,y:10"')
    writeFileSync(file, mine)
    await applyAzaharPad(dir, false)
    expect(read('user', 'config', 'qt-config.ini')).toBe(mine)
  })
  it('Azahar : configuration par jeu créée seulement pour un Title ID connu, jamais écrasée ; Title ID lu dans une ROM NCSD', async () => {
    const table = { '000400000008C300': { Layout: { 'layout_option\\use_global': false, layout_option: 0 } } }
    await applyAzaharGameConfig(dir, '000400000008C301', table)
    expect(existsSync(join(dir, 'user', 'config', 'custom'))).toBe(false)
    await applyAzaharGameConfig(dir, '000400000008c300', table)
    expect(read('user', 'config', 'custom', '000400000008C300.ini')).toContain('layout_option=0')
    writeFileSync(join(dir, 'user', 'config', 'custom', '000400000008C300.ini'), 'perso')
    await applyAzaharGameConfig(dir, '000400000008C300', table)
    expect(read('user', 'config', 'custom', '000400000008C300.ini')).toBe('perso')
    const header = Buffer.alloc(0x110)
    header.write('NCSD', 0x100, 'latin1')
    Buffer.from('000400000008C300', 'hex').reverse().copy(header, 0x108)
    expect(ncsdTitleId(header)).toBe('000400000008C300')
    expect(ncsdTitleId(Buffer.alloc(0x110))).toBeNull()
  })
  it('Eden : plein écran, Vulkan, caches, langue, audio système, clavier à l’installation puis manette XInput au lancement', async () => {
    await configureEmulator('eden', dir, ctx())
    const t = read('user', 'config', 'qt-config.ini')
    expect(t).toContain('fullscreen=true')
    expect(t).toContain('language=fr')
    // ConfirmStop::Ask_Never : sans ça, Retour+Start (fermeture RomVault) ouvre la boîte de confirmation d'Eden.
    expect(t).toContain('confirmStop=2')
    expect(t).toContain('confirmStop\\default=false')
    expect(t).toContain('backend=1')
    expect(t).toContain('use_disk_shader_cache=true')
    expect(t).toContain('use_vulkan_driver_pipeline_cache=true')
    // 1080p, GPU moyen : 1x = indice 3 de l'énumération récente (l'ancien choix, 2, était 0,75x)
    expect(t).toContain('resolution_setup=3')
    expect(t).toContain('output_engine=0')
    expect(t).toContain('output_device=auto')
    expect(t).toContain('volume=100')
    expect(t).not.toContain('player_0_button_a')
    expect(read('user', 'config', 'input', 'RomVault Clavier.ini')).toContain('button_a=engine:keyboard,code:67,toggle:0')
    // Manette Xbox One (XInput 045E:02FF) : mêmes liaisons qu'Eden écrit lui-même quand on la lui désigne (GUID du pilote XInput de SDL, joystick brut).
    const pad = { vid: 0x045e, pid: 0x02ff, ver: 0 }
    expect(sdlXInputGuid(pad.vid, pad.pid, pad.ver)).toBe('030000005e040000ff02000000007801')
    await applyEdenPad(dir, pad)
    const c = read('user', 'config', 'qt-config.ini')
    const g = '030000005e040000ff02000000007801'
    expect(c).toContain('player_0_button_a\\default=false')
    expect(c).toContain(`player_0_button_a=engine:sdl,port:0,guid:${g},button:1`)
    expect(c).toContain(`player_0_button_b=engine:sdl,port:0,guid:${g},button:0`)
    expect(c).toContain(`player_0_button_zl=engine:sdl,port:0,guid:${g},axis:2,threshold:0.5,invert:+`)
    expect(c).toContain(`player_0_button_dup=engine:sdl,port:0,guid:${g},hat:0,direction:up`)
    expect(c).toContain(`player_0_lstick=engine:sdl,port:0,guid:${g},axis_x:0,axis_y:1,offset_x:0,offset_y:0,invert_x:+,invert_y:+`)
    expect(c).toContain(`player_0_rstick=engine:sdl,port:0,guid:${g},axis_x:3,axis_y:4,offset_x:0,offset_y:0,invert_x:+,invert_y:+`)
    expect(c).not.toContain('motion')
    // Autre manette (autre VID/PID) au lancement suivant : les liaisons de RomVault suivent la manette branchée.
    await applyEdenPad(dir, { vid: 0x045e, pid: 0x028e, ver: 0 })
    expect(read('user', 'config', 'qt-config.ini')).toContain('player_0_button_a=engine:sdl,port:0,guid:030000005e0400008e02000000007801,button:1')
    // Identité illisible : rien n'est deviné.
    const before = read('user', 'config', 'qt-config.ini')
    await applyEdenPad(dir, { vid: 0, pid: 0, ver: 0 })
    expect(read('user', 'config', 'qt-config.ini')).toBe(before)
    // Manette débranchée : retour aux touches d'Eden (marqueur par défaut), sans effacer le reste.
    await applyEdenPad(dir, null)
    expect(read('user', 'config', 'qt-config.ini')).toContain('player_0_button_a\\default=true')
  })
  it('Eden : les anciennes liaisons de RomVault (GUID générique, jamais reconnu par Eden) sont remplacées', async () => {
    await configureEmulator('eden', dir, ctx())
    const file = join(dir, 'user', 'config', 'qt-config.ini')
    writeFileSync(file, `${read('user', 'config', 'qt-config.ini')}[Controls]
player_0_button_a\\default=false
player_0_button_a="engine:sdl,port:0,guid:78696e70757401000000000000000000,button:0"
`)
    await applyEdenPad(dir, { vid: 0x045e, pid: 0x02ff, ver: 0 })
    const c = read('user', 'config', 'qt-config.ini')
    expect(c).toContain('player_0_button_a=engine:sdl,port:0,guid:030000005e040000ff02000000007801,button:1')
    expect(c).not.toContain('78696e70757401000000000000000000')
  })
  it('Eden : une manette configurée à la main (autre GUID) n’est jamais réécrite', async () => {
    await configureEmulator('eden', dir, ctx())
    const file = join(dir, 'user', 'config', 'qt-config.ini')
    writeFileSync(file, `${read('user', 'config', 'qt-config.ini')}[Controls]\nplayer_0_button_a\\default=false\nplayer_0_button_a="engine:sdl,guid:030000005e040000,port:0,button:1"\n`)
    const before = read('user', 'config', 'qt-config.ini')
    await applyEdenPad(dir, { vid: 0x045e, pid: 0x02ff, ver: 0 })
    expect(read('user', 'config', 'qt-config.ini')).toBe(before)
    expect(isUntouchedEdenControls('player_0_button_a\\default=true\nplayer_0_button_a="engine:keyboard,code:67,toggle:0"')).toBe(true)
  })
  it('manettes : aucune liaison écrite à l’installation ne vise un matériel précis (GUID, VID/PID) — seule la manette détectée au lancement le fait', async () => {
    for (const id of ['retroarch', 'dolphin', 'duckstation', 'pcsx2', 'melonds', 'azahar', 'cemu', 'ppsspp', 'rpcs3', 'vita3k', 'eden']) {
      const d = join(dir, id)
      await configureEmulator(id, d, ctx({ biosDir: join(dir, 'bios') })).catch(() => undefined)
      const files: string[] = []
      const walk = (p: string): void => { for (const e of readdirSync(p, { withFileTypes: true })) { const f = join(p, e.name); if (e.isDirectory()) walk(f); else if (/\.(ini|toml|yml|xml|cfg)$/i.test(e.name)) files.push(f) } }
      if (existsSync(d)) walk(d)
      for (const f of files) {
        const t = readFileSync(f, 'utf8')
        // Azahar : GUID générique + `maptype:all` + `api:controller` = n'importe quelle manette SDL (vérifié dans son code) ; tout autre GUID serait propre à un matériel.
        const bad = t.split(/\r?\n/).filter((l) => /guid:[0-9a-f]{8,}/i.test(l) && !(/maptype:all/.test(l) && /api:controller/.test(l)))
        expect(bad, `${id} : ${f}`).toEqual([])
      }
    }
  })
  it('manettes : Azahar lit n’importe quelle manette SDL (API controller, tous ports) — aucune liaison ne dépend du GUID', async () => {
    await configureEmulator('azahar', dir, ctx())
    const c = read('user', 'config', 'qt-config.ini')
    const binds = c.split(/\r?\n/).filter((l) => /^profiles\\2\\(button_|[lr]stick|c_stick|circle_pad)/.test(l) && /guid:/.test(l))
    expect(binds.length).toBeGreaterThan(10)
    for (const l of binds) { expect(l).toContain('api:controller'); expect(l).toContain('maptype:all') }
  })
  it('manettes : Eden et melonDS (liaisons dépendantes du pilote SDL) sont lancés avec le pilote XInput imposé, les autres inchangés', () => {
    for (const id of ['eden', 'melonds']) expect(emulatorEnv(id)).toMatchObject({ SDL_JOYSTICK_HIDAPI: '0', SDL_JOYSTICK_RAWINPUT: '0', SDL_JOYSTICK_WGI: '0' })
    for (const id of ['azahar', 'dolphin', 'duckstation', 'pcsx2', 'ppsspp', 'retroarch', 'rpcs3', 'vita3k', 'cemu']) expect(emulatorEnv(id)).toBeUndefined()
  })
  it('manettes : Eden — le profil suit la manette détectée, jamais l’ancien GUID générique, quelle que soit la manette XInput', async () => {
    for (const [vid, pid] of [[0x045e, 0x02ff], [0x045e, 0x028e], [0x045e, 0x0b12], [0x0e6f, 0x0301], [0x046d, 0xc21d]]) {
      const d = join(dir, `eden-${vid.toString(16)}-${pid.toString(16)}`)
      await configureEmulator('eden', d, ctx())
      await applyEdenPad(d, { vid, pid, ver: 0 })
      const c = readFileSync(join(d, 'user', 'config', 'qt-config.ini'), 'utf8')
      const guid = sdlXInputGuid(vid, pid, 0)
      const lines = c.split(/\r?\n/).filter((l) => /^player_0_(button_(a|b|x|y|l|r|zl|zr|plus|minus|lstick|rstick|dup|ddown|dleft|dright)|lstick|rstick)=/.test(l))
      expect(lines.length).toBe(18)
      for (const l of lines) expect(l).toContain(`guid:${guid},`)
      expect(c).not.toContain('78696e70757401000000000000000000')
    }
  })
  it('Eden : résolution selon l’écran et le GPU, et selon l’énumération du binaire', () => {
    expect(edenResolution({ vulkan: true, tier: 'high' }, 2160)).toBe(6)
    expect(edenResolution({ vulkan: true, tier: 'high' }, 1440)).toBe(5)
    expect(edenResolution({ vulkan: true, tier: 'igpu' }, 2160)).toBe(2)
    expect(edenResolution({ vulkan: true, tier: 'low' }, 2160)).toBe(3)
    // Ancienne énumération (sans 1/4x ni 5/4x) : 1x = 2, 2x = 4
    expect(edenResolution({ vulkan: true, tier: 'mid' }, 1080, false)).toBe(2)
    expect(edenResolution({ vulkan: true, tier: 'high' }, 2160, false)).toBe(4)
    expect(hasQuarterResolutions(Buffer.from('xxRes5_4Xyy'))).toBe(true)
    expect(hasQuarterResolutions(Buffer.from('Res1_2X'))).toBe(false)
  })
  it('Eden : configuration par jeu créée seulement pour un Title ID connu, jamais écrasée', async () => {
    const table = { '0100000000010000': { Renderer: { 'resolution_setup\\use_global': false, resolution_setup: 3 } } }
    await applyEdenGameConfig(dir, '0100000000010001', table)
    expect(existsSync(join(dir, 'user', 'config', 'custom'))).toBe(false)
    await applyEdenGameConfig(dir, '0100000000010000', table)
    expect(read('user', 'config', 'custom', '0100000000010000.ini')).toContain('resolution_setup=3')
    writeFileSync(join(dir, 'user', 'config', 'custom', '0100000000010000.ini'), 'perso')
    await applyEdenGameConfig(dir, '0100000000010000', table)
    expect(read('user', 'config', 'custom', '0100000000010000.ini')).toBe('perso')
  })
  it('Cemu : sortie audio par défaut, clavier ET 1ère manette XInput sur le Pad 1 (Pro Controller par défaut, voir cemu.test.ts)', async () => {
    await configureEmulator('cemu', dir, ctx())
    const settings = read('settings.xml')
    expect(settings).toContain('<TVDevice>default</TVDevice>')
    expect(settings).toContain('<PadDevice>default</PadDevice>')
    expect(settings).toContain('<TVVolume>100</TVVolume>')
    expect(settings).toContain('<api>0</api>')
    const profile = read('controllerProfiles', 'controller0.xml')
    expect(profile).toContain('<type>Wii U Pro Controller</type>')
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
