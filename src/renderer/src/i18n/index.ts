import en from '../../../../locales/en.json'
import fr from '../../../../locales/fr.json'
import es from '../../../../locales/es.json'
import de from '../../../../locales/de.json'
import it from '../../../../locales/it.json'
import ptPt from '../../../../locales/pt-pt.json'
import { BUILTIN_LANGS, placeholderMismatches, translate, untranslatedKeys, type Dicts, type LangFile, type LangInfo } from '@shared/lang'

/** Langues livrées avec l'app : un fichier `locales/<code>.json` chacune, mêmes clés que l'anglais (test de parité). */
export const builtin: Dicts = { en, fr, es, de, it, 'pt-pt': ptPt }
const dicts: Dicts = { ...builtin }
/** Noms d'affichage des langues ajoutées par l'utilisateur. */
const userNames: Record<string, string> = {}
export type Lang = string
let current: Lang = 'en'

export function setLanguage(lang: Lang): void { current = dicts[lang] ? lang : 'en' }
export const getLang = (): Lang => current

/** Remplace l'ensemble des langues utilisateur (appelé au chargement et après un import/retrait). */
export function setUserLanguages(files: LangFile[]): void {
  for (const k of Object.keys(dicts)) if (!(k in builtin)) delete dicts[k]
  for (const k of Object.keys(userNames)) delete userNames[k]
  for (const f of files) if (!(f.code in builtin)) { dicts[f.code] = f.strings; userNames[f.code] = f.name }
  if (!dicts[current]) current = 'en'
}

/** Langues disponibles : intégrées d'abord, puis celles de l'utilisateur. */
export function availableLanguages(): LangInfo[] {
  return [
    ...Object.keys(builtin).map((code) => ({ code, name: BUILTIN_LANGS[code] ?? code, builtin: true })),
    ...Object.keys(userNames).map((code) => ({ code, name: userNames[code], builtin: false }))
  ]
}

/** Traduit une clé ; `{name}` est remplacé par params.name. Repli : anglais, puis la clé elle-même. */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(dicts, current, key, params)
}

/** Par langue intégrée : clés de l'anglais manquantes, clés en trop et variables `{x}` différentes (utilisé par les tests). */
export function localeReport(): Record<string, { missing: string[]; extra: string[]; placeholders: string[] }> {
  return Object.fromEntries(Object.entries(builtin).filter(([code]) => code !== 'en').map(([code, d]) => [code, {
    missing: untranslatedKeys(en, d),
    extra: untranslatedKeys(d, en),
    placeholders: placeholderMismatches(en, d)
  }]))
}

/** Clés de l'anglais qu'une langue ne traduit pas encore. */
export const missingIn = (code: string): string[] => untranslatedKeys(en, dicts[code] ?? {})
