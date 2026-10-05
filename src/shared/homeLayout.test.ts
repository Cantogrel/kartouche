import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings'
import { DEFAULT_HOME_LAYOUT, HOME_SECTIONS, homeStats, moveHomeSection, normalizeHomeLayout, reorderHomeSection, toggleHomeSection, visibleHomeSections } from './homeLayout'

describe('homeLayout', () => {
  it('normalise : doublons/inconnus ignorés, blocs manquants ajoutés', () => {
    // « stats » (ancien bloc réordonnable d'un réglage déjà enregistré) est ignoré : la ligne de stats est fixe.
    const l = normalizeHomeLayout({ order: ['recent', 'recent', 'zzz', 'stats'], hidden: ['stats', 'recent', 'nope'] })
    expect(l.order).toEqual(['recent', 'continue', 'favorites', 'collections'])
    expect(l.hidden).toEqual(['recent'])
    expect(normalizeHomeLayout(null)).toEqual(DEFAULT_HOME_LAYOUT)
  })
  it('déplace et masque', () => {
    let l = moveHomeSection(DEFAULT_HOME_LAYOUT, 'recent', -1)
    expect(l.order.indexOf('recent')).toBe(HOME_SECTIONS.indexOf('recent') - 1)
    expect(moveHomeSection(DEFAULT_HOME_LAYOUT, 'continue', -1)).toBe(DEFAULT_HOME_LAYOUT)
    l = toggleHomeSection(l, 'favorites')
    expect(visibleHomeSections(l)).not.toContain('favorites')
    expect(visibleHomeSections(toggleHomeSection(l, 'favorites'))).toContain('favorites')
  })
  it('réordonne par glisser-déposer', () => {
    const l = reorderHomeSection(DEFAULT_HOME_LAYOUT, 'collections', 0)
    expect(l.order).toEqual(['collections', 'continue', 'favorites', 'recent'])
    expect(reorderHomeSection(l, 'collections', 3).order).toEqual(['continue', 'favorites', 'recent', 'collections'])
    expect(reorderHomeSection(l, 'continue', 1)).toBe(l)
    expect(reorderHomeSection(l, 'continue', 9)).toBe(l)
  })
  it('réglages : persistance via mergeSettings, valeur invalide rétablie', () => {
    const s = mergeSettings(DEFAULT_SETTINGS, { homeLayout: { order: ['collections'], hidden: ['recent'] } })
    expect(s.homeLayout.order[0]).toBe('collections')
    expect(s.homeLayout.hidden).toEqual(['recent'])
    expect(mergeSettings(s, { homeLayout: 'x' }).homeLayout).toEqual(s.homeLayout)
  })
})

describe('homeStats', () => {
  it('compte les ROMs seulement quand il y a aussi des jeux PC', () => {
    expect(homeStats([{ kind: 'rom', playMinutes: 30 }, { kind: 'rom', playMinutes: 90 }])).toEqual({ games: 2, roms: 2, hours: 2, hasOther: false })
    expect(homeStats([{ kind: 'rom', playMinutes: 0 }, { kind: 'launcher', playMinutes: 60 }, { kind: 'exe', playMinutes: 0 }])).toEqual({ games: 3, roms: 1, hours: 1, hasOther: true })
  })
})
