import { create } from 'zustand'
import type { AppInfo } from '@shared/ipc'
import { DEFAULT_SETTINGS, resolveTheme, type Settings } from '@shared/settings'
import { pickLanguage, type LangInfo } from '@shared/lang'
import { availableLanguages, setLanguage, setUserLanguages, type Lang } from '@/i18n'

interface SettingsState {
  ready: boolean
  info: AppInfo | null
  settings: Settings
  lang: Lang
  /** Langues disponibles (intégrées + fichiers de l'utilisateur). */
  languages: LangInfo[]
  /** Relit les fichiers de langue de l'utilisateur et réapplique la langue choisie (après un import ou un retrait). */
  refreshLanguages: () => Promise<void>
  /** Thème effectif (clair/sombre) : réglage explicite, sinon thème système — suivi en direct via `listen`. */
  theme: 'light' | 'dark'
  load: () => Promise<void>
  update: (patch: Partial<Settings>) => Promise<void>
  listen: () => () => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  ready: false, info: null, settings: DEFAULT_SETTINGS, lang: 'en', languages: availableLanguages(), theme: 'dark',
  load: async () => {
    const [info, settings, userLangs] = await Promise.all([window.api.invoke('app:info'), window.api.invoke('settings:get'), window.api.invoke('lang:user')])
    setUserLanguages(userLangs)
    const lang = pickLanguage(settings.language, info.osLocale, availableLanguages().map((l) => l.code))
    setLanguage(lang)
    set({ info, settings, lang, languages: availableLanguages(), theme: resolveTheme(settings.theme, info.osDark), ready: true })
  },
  refreshLanguages: async () => {
    setUserLanguages(await window.api.invoke('lang:user'))
    const lang = pickLanguage(get().settings.language, get().info?.osLocale ?? 'en', availableLanguages().map((l) => l.code))
    setLanguage(lang)
    set({ lang, languages: availableLanguages() })
  },
  update: async (patch) => {
    const settings = await window.api.invoke('settings:set', patch)
    const lang = pickLanguage(settings.language, get().info?.osLocale ?? 'en', availableLanguages().map((l) => l.code))
    setLanguage(lang)
    set({ settings, lang, theme: resolveTheme(settings.theme, get().info?.osDark ?? false) })
  },
  // Réglage 'auto' : si l'utilisateur change le thème clair/sombre de Windows pendant que l'app tourne, suivre sans redémarrer.
  listen: () => window.api.on('theme:osDark', (osDark) => {
    const { info, settings } = get()
    set({ info: info ? { ...info, osDark } : info, theme: resolveTheme(settings.theme, osDark) })
  })
}))
