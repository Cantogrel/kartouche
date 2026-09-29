import { create } from 'zustand'
import type { UpdateState } from '@shared/ipc'

interface UpdateStore {
  state: UpdateState
  refresh: () => Promise<void>
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => void
  listen: () => () => void
}

export const useUpdate = create<UpdateStore>((set) => ({
  state: { status: 'idle', version: null, percent: 0, error: null },
  refresh: async () => set({ state: await window.api.invoke('update:state') }),
  check: async () => set({ state: await window.api.invoke('update:check') }),
  download: async () => { await window.api.invoke('update:download') },
  install: () => { void window.api.invoke('update:install') },
  listen: () => window.api.on('update:state', (state) => set({ state }))
}))
