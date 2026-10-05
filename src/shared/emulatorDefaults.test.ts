import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'

describe('réglage emulatorDefaults', () => {
  it('vaut {} par défaut et n’est jamais partagé entre deux copies des réglages', () => {
    expect(DEFAULT_SETTINGS.emulatorDefaults).toEqual({})
    const a = mergeSettings(DEFAULT_SETTINGS, { emulatorDefaults: { snes: 'custom-1' } })
    expect(a.emulatorDefaults).toEqual({ snes: 'custom-1' })
    expect(DEFAULT_SETTINGS.emulatorDefaults).toEqual({})
    const b = mergeSettings(a, {})
    b.emulatorDefaults['nes'] = 'custom-2'
    expect(a.emulatorDefaults).toEqual({ snes: 'custom-1' })
  })

  it('ignore ce qui n’est pas un identifiant de console vers un identifiant d’émulateur', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { emulatorDefaults: { snes: 'retroarch', 'bad key': 'x', nes: 42, gb: 'custom-1; calc', n64: '', gba: 'Retro Arch' } })
    expect(s.emulatorDefaults).toEqual({ snes: 'retroarch' })
    expect(mergeSettings(DEFAULT_SETTINGS, { emulatorDefaults: ['snes'] }).emulatorDefaults).toEqual({})
    expect(mergeSettings(DEFAULT_SETTINGS, { emulatorDefaults: null }).emulatorDefaults).toEqual({})
  })
})
