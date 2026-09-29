export type LanguageSetting = 'auto' | 'en' | 'fr'

export interface Settings {
  language: LanguageSetting
  /** Copier la ROM importée dans le dossier de l'app (sinon simple référence). */
  importCopy: boolean
  /** Proposer par défaut la suppression du fichier d'origine après import. */
  importDeleteSource: boolean
  scanFolders: string[]
  /** Ouvrir RomVault directement en Big Picture (aussi possible avec l'argument --bigpicture). */
  startInBigPicture: boolean
  /** Identifiants Twitch de l'utilisateur pour IGDB (jamais commités : stockés dans la base locale). */
  igdbClientId: string
  igdbClientSecret: string
  tgdbApiKey: string
  sgdbApiKey: string
  /** RetroAchievements : nom d'utilisateur et clé d'API Web (succès). */
  raUsername: string
  raApiKey: string
  /** Copie automatique des sauvegardes à la fin de chaque partie. */
  autoBackupSaves: boolean
  /** Manette : inverser A et B (valider = B, retour = A, disposition Nintendo). */
  padSwapAB: boolean
  /** Manette : seuil d'inclinaison du stick pour compter comme une direction (0.3 = sensible, 0.9 = ferme). */
  padThreshold: number
  /** Apparence : échelle de l'interface, couleur d'accent, animations réduites. */
  uiScale: number
  accent: Accent
  reduceMotion: boolean
}

export const ACCENTS = ['white', 'violet', 'blue', 'green', 'orange'] as const
export type Accent = (typeof ACCENTS)[number]
export const UI_SCALES = [0.9, 1, 1.1, 1.25, 1.5] as const

export const DEFAULT_SETTINGS: Settings = {
  language: 'auto',
  importCopy: true,
  importDeleteSource: false,
  scanFolders: [],
  startInBigPicture: false,
  igdbClientId: '',
  igdbClientSecret: '',
  tgdbApiKey: '',
  sgdbApiKey: '',
  raUsername: '',
  raApiKey: '',
  autoBackupSaves: true,
  padSwapAB: false,
  padThreshold: 0.6,
  uiScale: 1,
  accent: 'violet',
  reduceMotion: false
}

/** Fusionne une saisie partielle non fiable avec les valeurs actuelles : toute valeur invalide est ignorée. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const out: Settings = { ...base, scanFolders: [...base.scanFolders] }
  if (typeof patch !== 'object' || patch === null) return out
  const p = patch as Record<string, unknown>
  if (p.language === 'auto' || p.language === 'en' || p.language === 'fr') out.language = p.language
  if (typeof p.importCopy === 'boolean') out.importCopy = p.importCopy
  if (typeof p.importDeleteSource === 'boolean') out.importDeleteSource = p.importDeleteSource
  if (typeof p.startInBigPicture === 'boolean') out.startInBigPicture = p.startInBigPicture
  if (Array.isArray(p.scanFolders) && p.scanFolders.every((x) => typeof x === 'string')) out.scanFolders = [...new Set(p.scanFolders as string[])]
  if (typeof p.igdbClientId === 'string') out.igdbClientId = p.igdbClientId.trim()
  if (typeof p.igdbClientSecret === 'string') out.igdbClientSecret = p.igdbClientSecret.trim()
  if (typeof p.tgdbApiKey === 'string') out.tgdbApiKey = p.tgdbApiKey.trim()
  if (typeof p.sgdbApiKey === 'string') out.sgdbApiKey = p.sgdbApiKey.trim()
  if (typeof p.raUsername === 'string') out.raUsername = p.raUsername.trim()
  if (typeof p.raApiKey === 'string') out.raApiKey = p.raApiKey.trim()
  if (typeof p.autoBackupSaves === 'boolean') out.autoBackupSaves = p.autoBackupSaves
  if (typeof p.padSwapAB === 'boolean') out.padSwapAB = p.padSwapAB
  if (typeof p.padThreshold === 'number' && p.padThreshold >= 0.3 && p.padThreshold <= 0.9) out.padThreshold = Math.round(p.padThreshold * 100) / 100
  if (typeof p.uiScale === 'number' && (UI_SCALES as readonly number[]).includes(p.uiScale)) out.uiScale = p.uiScale
  if (typeof p.accent === 'string' && (ACCENTS as readonly string[]).includes(p.accent)) out.accent = p.accent as Accent
  if (typeof p.reduceMotion === 'boolean') out.reduceMotion = p.reduceMotion
  return out
}

/** Langue effective : réglage explicite, sinon langue de l'OS (français si l'OS est en français, anglais sinon). */
export function resolveLanguage(setting: LanguageSetting, osLocale: string): 'en' | 'fr' {
  if (setting !== 'auto') return setting
  return osLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}
