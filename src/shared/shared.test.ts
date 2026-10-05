import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, resolveLanguage, resolveTheme } from './settings'
import { builtin, localeReport, setLanguage, t } from '../renderer/src/i18n'
import { BUILTIN_LANGS } from './lang'

describe('resolveLanguage', () => {
  it("suit la langue de l'OS en mode auto", () => {
    expect(resolveLanguage('auto', 'fr-FR')).toBe('fr')
    expect(resolveLanguage('auto', 'FR')).toBe('fr')
    expect(resolveLanguage('auto', 'en-US')).toBe('en')
    expect(resolveLanguage('auto', 'de-DE')).toBe('en')
  })
  it('respecte le choix explicite', () => {
    expect(resolveLanguage('en', 'fr-FR')).toBe('en')
    expect(resolveLanguage('fr', 'en-US')).toBe('fr')
  })
})

describe('mergeSettings', () => {
  it('ne mute pas la base et déduplique les dossiers', () => {
    const out = mergeSettings(DEFAULT_SETTINGS, { scanFolders: ['a', 'a', 'b'] })
    expect(out.scanFolders).toEqual(['a', 'b'])
    expect(DEFAULT_SETTINGS.scanFolders).toEqual([])
  })
  it('ignore un patch non objet ou un tableau mal typé', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(DEFAULT_SETTINGS, { scanFolders: [1] })).toEqual(DEFAULT_SETTINGS)
  })
  it('accepte un thème valide et ignore une valeur invalide', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { theme: 'light' }).theme).toBe('light')
    expect(mergeSettings(DEFAULT_SETTINGS, { theme: 'nope' }).theme).toBe(DEFAULT_SETTINGS.theme)
  })
})

describe('resolveTheme', () => {
  it("suit le thème de l'OS en mode auto", () => {
    expect(resolveTheme('auto', true)).toBe('dark')
    expect(resolveTheme('auto', false)).toBe('light')
  })
  it('respecte le choix explicite', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('i18n', () => {
  it('toutes les langues intégrées ont exactement les clés et les variables de l’anglais', () => {
    expect(Object.keys(builtin).sort()).toEqual(Object.keys(BUILTIN_LANGS).sort())
    for (const [code, r] of Object.entries(localeReport())) expect({ code, ...r }).toEqual({ code, missing: [], extra: [], placeholders: [] })
  })
  it('aucune traduction vide', () => {
    for (const [code, d] of Object.entries(builtin)) expect({ code, empty: Object.entries(d).filter(([, v]) => v.trim() === '').map(([k]) => k) }).toEqual({ code, empty: [] })
  })
  it('interpole les paramètres et se replie sur la clé', () => {
    setLanguage('en')
    expect(t('game.playtime', { n: 5 })).toBe('5 minutes played')
    expect(t('cle.inconnue')).toBe('cle.inconnue')
    setLanguage('fr')
    expect(t('play')).toBe('Jouer')
    setLanguage('en')
  })
})
