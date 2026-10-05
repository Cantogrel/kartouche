import { describe, expect, it } from 'vitest'
import { accentReadable, contrastRatio, readableOn } from './appearance'
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
  it('réglages : valeurs invalides ignorées', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { accentColor: 'nope', radius: 'x', highContrast: 'oui' })
    expect(s.accentColor).toBe('')
    expect(s.radius).toBe('normal')
    expect(s.highContrast).toBe(false)
  })
})
