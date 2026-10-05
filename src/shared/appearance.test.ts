import { describe, expect, it } from 'vitest'
import { accentReadable, contrastRatio, exportTheme, parseTheme, readableOn } from './appearance'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'

describe('appearance', () => {
  it('contraste WCAG', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(readableOn('#ffffff')).toBe('#0e0e0e')
    expect(readableOn('#101040')).toBe('#ffffff')
    expect(accentReadable('#202020', 'dark')).toBe(false)
    expect(accentReadable('#202020', 'light')).toBe(true)
    expect(accentReadable('#7c8cff', 'dark')).toBe(true)
  })
  it('export puis import redonne le même thème', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { theme: 'light', accent: 'green', accentColor: '#AA3355', uiScale: 1.25, radius: 'round', highContrast: true, reduceMotion: true })
    const parsed = parseTheme(exportTheme(s))
    expect(parsed).toEqual({ theme: 'light', accent: 'green', accentColor: '#aa3355', uiScale: 1.25, radius: 'round', highContrast: true, reduceMotion: true })
    expect(mergeSettings(DEFAULT_SETTINGS, parsed)).toMatchObject(parsed!)
  })
  it('import refuse un texte étranger et ignore les valeurs invalides', () => {
    expect(parseTheme('pas du json')).toBeNull()
    expect(parseTheme('{"format":"autre"}')).toBeNull()
    expect(parseTheme('{"format":"kartouche.theme/v1","accentColor":"rouge","radius":"x","uiScale":7,"theme":"dark"}')).toEqual({ theme: 'dark' })
  })
  it('réglages : valeurs invalides ignorées', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { accentColor: 'nope', radius: 'x', highContrast: 'oui' })
    expect(s.accentColor).toBe('')
    expect(s.radius).toBe('normal')
    expect(s.highContrast).toBe(false)
  })
})
