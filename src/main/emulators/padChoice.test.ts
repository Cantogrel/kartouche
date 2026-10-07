import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preferActive, rankAmong } from './padChoice'
import { applyMelondsPad, expandSdlPads, migrateHybridLayout } from './configure'
import { expandXInputPads } from './ppsspp'
import { applyCemuPad, cemuProfileXml } from './cemu'

describe('manette à lire', () => {
  it('met en premier la manette sur laquelle on a appuyé, le reste dans l\'ordre', () => {
    expect(preferActive([0, 1, 2], (s) => s, 2)).toEqual([2, 0, 1])
    expect(preferActive([0, 1, 2], (s) => s, 0)).toEqual([0, 1, 2])
  })
  it('garde l\'ordre de Windows sans information ou si la manette active est débranchée', () => {
    expect(preferActive([0, 1], (s) => s, null)).toEqual([0, 1])
    expect(preferActive([0, 1], (s) => s, 3)).toEqual([0, 1])
  })
  it('donne à melonDS le rang de la manette parmi les manettes branchées', () => {
    expect(rankAmong([0, 1, 2], 2)).toBe(2)
    expect(rankAmong([1, 3], 3)).toBe(1)
  })
  it('réécrit JoystickID de melonDS sans toucher au reste', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melon-'))
    await writeFile(join(dir, 'melonDS.toml'), '[Instance0]\nJoystickID = 0\nOther = 5\n\n[Instance0.Keyboard]\nA = 76\n')
    await applyMelondsPad(dir, 2)
    expect(await readFile(join(dir, 'melonDS.toml'), 'utf8')).toBe('[Instance0]\nJoystickID = 2\nOther = 5\n\n[Instance0.Keyboard]\nA = 76\n')
    await applyMelondsPad(dir, null)
    expect(await readFile(join(dir, 'melonDS.toml'), 'utf8')).toContain('JoystickID = 2')
  })
})

describe('manettes SDL de DuckStation et PCSX2', () => {
  it('ajoute les manettes 1 à 3 à chaque liaison SDL-0 de [Pad1], une seule fois, sans toucher aux moteurs ni au clavier', () => {
    const before = '[Main]\nA = 1\n\n[Pad1]\nType = DualShock2\nCross = Keyboard/K\nCross = SDL-0/A\nLargeMotor = SDL-0/LargeMotor\n\n[Other]\nCross = SDL-0/A\n'
    const once = expandSdlPads(before)
    expect(once).toBe('[Main]\nA = 1\n\n[Pad1]\nType = DualShock2\nCross = Keyboard/K\nCross = SDL-0/A\nCross = SDL-1/A\nCross = SDL-2/A\nCross = SDL-3/A\nLargeMotor = SDL-0/LargeMotor\n\n[Other]\nCross = SDL-0/A\n')
    expect(expandSdlPads(once)).toBe(once)
  })
})

describe('manette XInput de Cemu', () => {
  it('change seulement l\'emplacement dans un profil Kartouche, jamais dans un profil retouché', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cemu-'))
    await mkdir(join(dir, 'controllerProfiles'))
    const file = join(dir, 'controllerProfiles', 'controller0.xml')
    await writeFile(file, cemuProfileXml('pro'))
    await applyCemuPad(dir, 2)
    expect(await readFile(file, 'utf8')).toBe(cemuProfileXml('pro', 2))
    await writeFile(file, cemuProfileXml('pro').replace(/<!--.*?-->\n/, ''))
    const edited = await readFile(file, 'utf8')
    await applyCemuPad(dir, 1)
    expect(await readFile(file, 'utf8')).toBe(edited)
  })
})

describe('PPSSPP : manettes XInput 0 à 3', () => {
  it('ajoute 21, 22 et 23 à chaque liaison 20-…, sans toucher au reste, une seule fois', () => {
    const before = '[ControlMapping]\nUp = 1-19,20-19,10-19\nAnalog limiter = 1-60\nPause = 1-111,20-4034,20-3,10-109\n'
    const once = expandXInputPads(before)
    expect(once).toBe('[ControlMapping]\nUp = 1-19,20-19,10-19,21-19,22-19,23-19\nAnalog limiter = 1-60\nPause = 1-111,20-4034,20-3,10-109,21-4034,22-4034,23-4034,21-3,22-3,23-3\n')
    expect(expandXInputPads(once)).toBe(once)
  })
})

describe('disposition hybride', () => {
  it('passe melonDS et Azahar à l\'hybride une fois, seulement depuis l\'ancienne valeur', async () => {
    const m = await mkdtemp(join(tmpdir(), 'melon-'))
    await writeFile(join(m, 'melonDS.toml'), '[Instance0.Window0]\nScreenLayout = 0\nScreenGap = 8\n')
    await migrateHybridLayout('melonds', m)
    expect(await readFile(join(m, 'melonDS.toml'), 'utf8')).toContain('ScreenLayout = 3')
    await writeFile(join(m, 'melonDS.toml'), '[Instance0.Window0]\nScreenLayout = 0\n')
    await migrateHybridLayout('melonds', m)
    expect(await readFile(join(m, 'melonDS.toml'), 'utf8')).toContain('ScreenLayout = 0')
    const a = await mkdtemp(join(tmpdir(), 'azahar-'))
    await mkdir(join(a, 'user', 'config'), { recursive: true })
    await writeFile(join(a, 'user', 'config', 'qt-config.ini'), '[Layout]\nlayout_option\default=false\nlayout_option=2\n')
    await migrateHybridLayout('azahar', a)
    expect(await readFile(join(a, 'user', 'config', 'qt-config.ini'), 'utf8')).toContain('layout_option=5')
  })
})
