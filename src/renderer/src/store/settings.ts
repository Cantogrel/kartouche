import { create } from 'zustand'
import type { AppInfo } from '@shared/ipc'
import { DEFAULT_SETTINGS, resolveLanguage, resolveTheme, type Settings } from '@shared/settings'
import { setLanguage, type Lang } from '@/i18n'

interface SettingsState {
  ready: boolean
  info: AppInfo | null
  settings: Settings
  lang: Lang
  /** Thème effectif (clair/sombre) : réglage explicite, sinon thème système — suivi en direct via `listen`. */
  theme: 'light' | 'dark'
  load: () => Promise<void>
  update: (patch: Partial<Settings>) => Promise<void>
  listen: () => () => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  ready: false, info: null, settings: DEFAULT_SETTINGS, lang: 'en', theme: 'dark',
  load: async () => {
    const [info, settings] = await Promise.all([window.api.invoke('app:info'), window.api.invoke('settings:get')])
    const lang = resolveLanguage(settings.language, info.osLocale)
    setLanguage(lang)
    set({ info, settings, lang, theme: resolveTheme(settings.theme, info.osDark), ready: true })
  },
  update: async (patch) => {
    const settings = await window.api.invoke('settings:set', patch)
    const lang = resolveLanguage(settings.language, get().info?.osLocale ?? 'en')
    setLanguage(lang)
    set({ settings, lang, theme: resolveTheme(settings.theme, get().info?.osDark ?? false) })
  },
  // Réglage 'auto' : si l'utilisateur change le thème clair/sombre de Windows pendant que l'app tourne, suivre sans redémarrer.
  listen: () => window.api.on('theme:osDark', (osDark) => {
    const { info, settings } = get()
    set({ info: info ? { ...info, osDark } : info, theme: resolveTheme(settings.theme, osDark) })
  })
}))
