import { describe, expect, it } from 'vitest'
import { langTemplate, parseLangFile, pickLanguage, translate, untranslatedKeys } from './lang'
import { DEFAULT_SETTINGS, mergeSettings, resolveLanguage } from './settings'

const file = (o: Record<string, unknown>): string => JSON.stringify({ format: 'kartouche.lang/v1', code: 'sv', name: 'Español', strings: { play: 'Jugar' }, ...o })

describe('parseLangFile', () => {
  it('accepte un fichier valide et normalise le code', () => {
    const r = parseLangFile(file({ code: 'PT-BR', strings: { play: 'Jogar', n: 3, vide: '' } }))
    expect(r).toEqual({ ok: true, file: { code: 'pt-br', name: 'Español', strings: { play: 'Jogar' } } })
  })
  it('refuse les fichiers invalides', () => {
    expect(parseLangFile('pas json')).toMatchObject({ error: 'json' })
    expect(parseLangFile('[]')).toMatchObject({ error: 'format' })
    expect(parseLangFile(file({ format: 'x' }))).toMatchObject({ error: 'format' })
    expect(parseLangFile(file({ code: 'Español' }))).toMatchObject({ error: 'code' })
    expect(parseLangFile(file({ code: '../x' }))).toMatchObject({ error: 'code' })
    expect(parseLangFile(file({ name: ' ' }))).toMatchObject({ error: 'name' })
    expect(parseLangFile(file({ strings: {} }))).toMatchObject({ error: 'strings' })
    expect(parseLangFile(file({ strings: null }))).toMatchObject({ error: 'strings' })
    expect(parseLangFile(file({ code: 'fr' }))).toMatchObject({ error: 'builtin' })
    expect(parseLangFile('x'.repeat(3 * 1024 * 1024))).toMatchObject({ error: 'size' })
  })
  it('le modèle exporté est lisible une fois le code changé', () => {
    const tpl = JSON.parse(langTemplate({ play: 'Play' })) as Record<string, unknown>
    expect(parseLangFile(JSON.stringify({ ...tpl, code: 'sv' })).ok).toBe(true)
  })
})

describe('choix de la langue', () => {
  const avail = ['en', 'fr', 'es', 'pt-br', 'pt-pt']
  it('réglage explicite disponible', () => expect(pickLanguage('es', 'fr-FR', avail)).toBe('es'))
  it('auto : code exact, puis code de base, sinon anglais', () => {
    expect(pickLanguage('auto', 'pt-BR', avail)).toBe('pt-br')
    expect(pickLanguage('auto', 'es-MX', avail)).toBe('es')
    expect(pickLanguage('auto', 'fr_CA', avail)).toBe('fr')
    expect(pickLanguage('auto', 'ja-JP', avail)).toBe('en')
  })
  it('chinois / japonais du système → langues CJK intégrées', () => {
    const cjk = ['en', 'zh-hans', 'ja']
    expect(pickLanguage('auto', 'zh-CN', cjk)).toBe('zh-hans')
    expect(pickLanguage('auto', 'ja-JP', cjk)).toBe('ja')
  })
  it("langue retirée : retombe sur celle de l'OS", () => expect(pickLanguage('de', 'fr-FR', avail)).toBe('fr'))
  it('réglages : code valide accepté, invalide ignoré ; main reste en/fr', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { language: 'pt-br' }).language).toBe('pt-br')
    expect(mergeSettings(DEFAULT_SETTINGS, { language: '../etc' }).language).toBe('auto')
    expect(resolveLanguage('es', 'fr-FR')).toBe('en')
    expect(resolveLanguage('auto', 'fr-FR')).toBe('fr')
  })
})

describe('traduction', () => {
  const dicts = { en: { a: 'A {n}', b: 'B' }, es: { a: 'Á {n}' } }
  it('clés manquantes → anglais, puis la clé', () => {
    expect(translate(dicts, 'es', 'a', { n: 2 })).toBe('Á 2')
    expect(translate(dicts, 'es', 'b')).toBe('B')
    expect(translate(dicts, 'es', 'zz')).toBe('zz')
    expect(translate(dicts, 'xx', 'b')).toBe('B')
    expect(untranslatedKeys(dicts.en, dicts.es)).toEqual(['b'])
  })
})
