import en from '../../../../locales/en.json'
import fr from '../../../../locales/fr.json'

const dicts: Record<string, Record<string, string>> = { en, fr }
export type Lang = 'en' | 'fr'
let current: Lang = 'en'

export function setLanguage(lang: Lang): void { current = lang }
export const getLang = (): Lang => current

/** Traduit une clé ; `{name}` est remplacé par params.name. Repli : anglais, puis la clé elle-même. */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = dicts[current][key] ?? dicts.en[key] ?? key
  return params ? raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? '')) : raw
}

/** Clés présentes dans une langue mais absentes de l'autre (utilisé par les tests). */
export function missingKeys(): Record<string, string[]> {
  const keys = (d: Record<string, string>): string[] => Object.keys(d)
  return {
    fr: keys(en).filter((k) => !(k in fr)),
    en: keys(fr).filter((k) => !(k in en))
  }
}
