import { create } from 'zustand'
import type { AppInfo } from '@shared/ipc'
import { DEFAULT_SETTINGS, resolveLanguage, type Settings } from '@shared/settings'
import { setLanguage, type Lang } from '@/i18n'

interface SettingsState {
  ready: boolean
  info: AppInfo | null
  settings: Settings
  lang: Lang
  load: () => Promise<void>
  update: (patch: Partial<Settings>) => Promise<void>
}

export const useSettings = create<SettingsState>((set, get) => ({
  ready: false, info: null, settings: DEFAULT_SETTINGS, lang: 'en',
  load: async () => {
    const [info, settings] = await Promise.all([window.api.invoke('app:info'), window.api.invoke('settings:get')])
    const lang = resolveLanguage(settings.language, info.osLocale)
    setLanguage(lang)
    set({ info, settings, lang, ready: true })
  },
  update: async (patch) => {
    const settings = await window.api.invoke('settings:set', patch)
    const lang = resolveLanguage(settings.language, get().info?.osLocale ?? 'en')
    setLanguage(lang)
    set({ settings, lang })
  }
}))
