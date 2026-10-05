/** Moteur de langues : formats, validation d'un fichier de langue utilisateur, choix de la langue effective. Pur (testable sans Electron). */

export const LANG_FORMAT = 'kartouche.lang/v1'
export const MAX_LANG_FILE_BYTES = 2 * 1024 * 1024
/** Code court (fr, es, pt-br, zh-hans) : minuscules, 2 à 3 lettres puis sous-étiquettes optionnelles. */
export const LANG_CODE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$/

export const isLangCode = (s: unknown): s is string => typeof s === 'string' && LANG_CODE_RE.test(s)

/** Langues livrées avec l'app (le fichier de référence est l'anglais). */
export const BUILTIN_LANGS: Record<string, string> = { en: 'English', fr: 'Français', es: 'Español', de: 'Deutsch', it: 'Italiano', 'pt-pt': 'Português (Portugal)' }

export interface LangFile {
  code: string
  name: string
  strings: Record<string, string>
}

export interface LangInfo {
  code: string
  name: string
  builtin: boolean
}

export type LangParse = { ok: true; file: LangFile } | { ok: false; error: 'size' | 'json' | 'format' | 'code' | 'name' | 'strings' | 'builtin' }

/** Lit un fichier de langue : `{ "format": "kartouche.lang/v1", "code": "es", "name": "Español", "strings": { "clé": "texte" } }`. Les valeurs non textuelles sont ignorées. */
export function parseLangFile(text: string, builtinCodes: readonly string[] = Object.keys(BUILTIN_LANGS)): LangParse {
  if (text.length > MAX_LANG_FILE_BYTES) return { ok: false, error: 'size' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, error: 'json' } }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'format' }
  const r = raw as Record<string, unknown>
  if (r.format !== LANG_FORMAT) return { ok: false, error: 'format' }
  const code = typeof r.code === 'string' ? r.code.trim().toLowerCase() : ''
  if (!isLangCode(code)) return { ok: false, error: 'code' }
  if (builtinCodes.includes(code)) return { ok: false, error: 'builtin' }
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (name.length === 0 || name.length > 60) return { ok: false, error: 'name' }
  if (typeof r.strings !== 'object' || r.strings === null || Array.isArray(r.strings)) return { ok: false, error: 'strings' }
  const strings: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.strings as Record<string, unknown>)) if (typeof v === 'string' && v.length > 0) strings[k] = v
  if (Object.keys(strings).length === 0) return { ok: false, error: 'strings' }
  return { ok: true, file: { code, name, strings } }
}

/** Modèle à remplir pour traduire : toutes les clés de l'anglais. */
export const langTemplate = (en: Record<string, string>): string =>
  JSON.stringify({ format: LANG_FORMAT, code: 'xx', name: 'Language name', strings: en }, null, 2)

/**
 * Langue effective. Réglage explicite disponible → lui ; sinon (auto ou langue disparue) celle de l'OS : code exact (pt-br),
 * puis code de base (pt), sinon anglais.
 */
export function pickLanguage(setting: string, osLocale: string, available: readonly string[]): string {
  if (setting !== 'auto' && available.includes(setting)) return setting
  const os = osLocale.toLowerCase().replace('_', '-')
  if (available.includes(os)) return os
  const base = os.split('-')[0]
  if (available.includes(base)) return base
  // Variante régionale seule disponible (pt-BR du système → pt-pt) : mieux que l'anglais.
  return available.find((a) => a.startsWith(`${base}-`)) ?? 'en'
}

/** Clés de l'anglais absentes d'une langue (elles s'afficheront en anglais). */
export const untranslatedKeys = (en: Record<string, string>, lang: Record<string, string>): string[] => Object.keys(en).filter((k) => !(k in lang))

export type Dicts = Record<string, Record<string, string>>

/** Variables `{x}` d'un texte (une traduction doit garder exactement les mêmes). */
export const placeholdersOf = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()

/** Clés d'une langue dont les variables `{x}` diffèrent de l'anglais. */
export const placeholderMismatches = (en: Record<string, string>, lang: Record<string, string>): string[] =>
  Object.keys(lang).filter((k) => k in en && placeholdersOf(en[k]).join() !== placeholdersOf(lang[k]).join())

/** Traduit une clé : langue courante, puis anglais, puis la clé elle-même ; `{name}` est remplacé par params.name. */
export function translate(dicts: Dicts, lang: string, key: string, params?: Record<string, string | number>): string {
  const raw = dicts[lang]?.[key] ?? dicts.en?.[key] ?? key
  return params ? raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? '')) : raw
}
