import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { DEFAULT_HOME_LAYOUT, HOME_SECTIONS, moveHomeSection, normalizeHomeLayout, reorderHomeSection, toggleHomeSection, visibleHomeSections } from './homeLayout'

describe('homeLayout', () => {
  it('normalise : doublons/inconnus ignorés, blocs manquants ajoutés', () => {
    const l = normalizeHomeLayout({ order: ['recent', 'recent', 'zzz', 'stats'], hidden: ['stats', 'nope'] })
    expect(l.order).toEqual(['recent', 'stats', 'continue', 'favorites', 'collections'])
    expect(l.hidden).toEqual(['stats'])
    expect(normalizeHomeLayout(null)).toEqual(DEFAULT_HOME_LAYOUT)
  })
  it('déplace et masque', () => {
    let l = moveHomeSection(DEFAULT_HOME_LAYOUT, 'recent', -1)
    expect(l.order.indexOf('recent')).toBe(HOME_SECTIONS.indexOf('recent') - 1)
    expect(moveHomeSection(DEFAULT_HOME_LAYOUT, 'stats', -1)).toBe(DEFAULT_HOME_LAYOUT)
    l = toggleHomeSection(l, 'favorites')
    expect(visibleHomeSections(l)).not.toContain('favorites')
    expect(visibleHomeSections(toggleHomeSection(l, 'favorites'))).toContain('favorites')
  })
  it('réordonne par glisser-déposer', () => {
    const l = reorderHomeSection(DEFAULT_HOME_LAYOUT, 'collections', 0)
    expect(l.order).toEqual(['collections', 'stats', 'continue', 'favorites', 'recent'])
    expect(reorderHomeSection(l, 'collections', 4).order).toEqual(['stats', 'continue', 'favorites', 'recent', 'collections'])
    expect(reorderHomeSection(l, 'stats', 1)).toBe(l)
    expect(reorderHomeSection(l, 'stats', 9)).toBe(l)
  })
  it('réglages : persistance via mergeSettings, valeur invalide rétablie', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { homeLayout: { order: ['collections'], hidden: ['recent'] } })
    expect(s.homeLayout.order[0]).toBe('collections')
    expect(s.homeLayout.hidden).toEqual(['recent'])
    expect(mergeSettings(s, { homeLayout: 'x' }).homeLayout).toEqual(s.homeLayout)
  })
})
