import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { DEFAULT_HOME_LAYOUT, HOME_SECTIONS, moveHomeSection, normalizeHomeLayout, toggleHomeSection, visibleHomeSections } from './homeLayout'

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
  it('réglages : persistance via mergeSettings, valeur invalide rétablie', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { homeLayout: { order: ['collections'], hidden: ['recent'] } })
    expect(s.homeLayout.order[0]).toBe('collections')
    expect(s.homeLayout.hidden).toEqual(['recent'])
    expect(mergeSettings(s, { homeLayout: 'x' }).homeLayout).toEqual(s.homeLayout)
  })
})
