import en from '../../../../locales/en.json'
import fr from '../../../../locales/fr.json'

const dicts: Record<string, Record<string, string>> = { en, fr }
export type Lang = 'en' | 'fr'
let current: Lang = 'en'

export function setLang(osLocale: string): Lang {
  current = osLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
  return current
}
export const t = (key: string): string => dicts[current][key] ?? dicts.en[key] ?? key
