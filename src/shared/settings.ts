export type LanguageSetting = 'auto' | 'en' | 'fr'

export interface Settings {
  language: LanguageSetting
  /** Copier la ROM importée dans le dossier de l'app (sinon simple référence). */
  importCopy: boolean
  /** Proposer par défaut la suppression du fichier d'origine après import. */
  importDeleteSource: boolean
  scanFolders: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'auto',
  importCopy: true,
  importDeleteSource: false,
  scanFolders: []
}

/** Fusionne une saisie partielle non fiable avec les valeurs actuelles : toute valeur invalide est ignorée. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const out: Settings = { ...base, scanFolders: [...base.scanFolders] }
  if (typeof patch !== 'object' || patch === null) return out
  const p = patch as Record<string, unknown>
  if (p.language === 'auto' || p.language === 'en' || p.language === 'fr') out.language = p.language
  if (typeof p.importCopy === 'boolean') out.importCopy = p.importCopy
  if (typeof p.importDeleteSource === 'boolean') out.importDeleteSource = p.importDeleteSource
  if (Array.isArray(p.scanFolders) && p.scanFolders.every((x) => typeof x === 'string')) out.scanFolders = [...new Set(p.scanFolders as string[])]
  return out
}

/** Langue effective : réglage explicite, sinon langue de l'OS (français si l'OS est en français, anglais sinon). */
export function resolveLanguage(setting: LanguageSetting, osLocale: string): 'en' | 'fr' {
  if (setting !== 'auto') return setting
  return osLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}
