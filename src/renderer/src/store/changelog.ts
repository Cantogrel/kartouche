import { create } from 'zustand'
import type { UpdateChangelog } from '@shared/ipc'

interface ChangelogStore {
  open: boolean
  data: UpdateChangelog
  /** Popup automatique, une seule fois après une mise à jour installée (voir `update:pendingChangelog`). */
  showPending: () => Promise<void>
  /** Rouvre le dernier changelog connu, quelle que soit la version (bouton « À propos » des Paramètres). */
  showLast: () => Promise<void>
  close: () => void
}

export const useChangelog = create<ChangelogStore>((set) => ({
  open: false,
  data: null,
  showPending: async () => {
    const data = await window.api.invoke('update:pendingChangelog')
    if (data) set({ data, open: true })
  },
  showLast: async () => {
    const data = await window.api.invoke('update:lastChangelog')
    set({ data, open: !!data })
  },
  close: () => set({ open: false })
}))
