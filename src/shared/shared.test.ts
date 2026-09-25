import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, resolveLanguage } from './settings'
import { missingKeys, setLanguage, t } from '../renderer/src/i18n'

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
})

describe('i18n', () => {
  it('a les mêmes clés en EN et FR', () => {
    expect(missingKeys()).toEqual({ fr: [], en: [] })
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
