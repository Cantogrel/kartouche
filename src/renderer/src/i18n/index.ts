import en from '../../../../locales/en.json'
import fr from '../../../../locales/fr.json'

const dicts: Record<string, Record<string, string>> = { en, fr }
export type Lang = 'en' | 'fr'
let current: Lang = 'en'

export function setLang(osLocale: string): Lang {
  current = osLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  return current
}
export const getLang = (): Lang => current

/** Traduit une clé ; `{name}` est remplacé par params.name. */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = dicts[current][key] ?? dicts.en[key] ?? key
  return params ? raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? '')) : raw
}
