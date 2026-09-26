import { create } from 'zustand'
import type { EmulatorProgress, EmulatorState, LatestVersion, LaunchResult } from '@shared/emulators'

interface EmulatorsState {
  list: EmulatorState[]
  loaded: boolean
  progress: Record<string, EmulatorProgress>
  errors: Record<string, string>
  latest: Record<string, string | null>
  checking: boolean
  /** Jeux (ids de la bibliothèque) actuellement ouverts dans un émulateur. */
  running: number[]
  refresh: () => Promise<void>
  install: (id: string) => Promise<void>
  uninstall: (id: string) => Promise<void>
  locate: (id: string) => Promise<void>
  check: () => Promise<void>
  play: (entryId: number) => Promise<LaunchResult>
  listen: () => () => void
}

export const useEmulators = create<EmulatorsState>((set, get) => ({
  list: [], loaded: false, progress: {}, errors: {}, latest: {}, checking: false, running: [],
  refresh: async () => {
    const [list, running] = await Promise.all([window.api.invoke('emulators:list'), window.api.invoke('game:running')])
    set({ list, running, loaded: true })
  },
  install: async (id) => {
    if (get().progress[id]) return
    set((s) => ({ progress: { ...s.progress, [id]: { id, phase: 'resolve', done: 0, total: 0 } }, errors: { ...s.errors, [id]: '' } }))
    const res = await window.api.invoke('emulators:install', id)
    set((s) => {
      const progress = { ...s.progress }
      delete progress[id]
      return { progress, errors: { ...s.errors, [id]: res.ok ? '' : res.error ?? 'error' } }
    })
    await get().refresh()
  },
  uninstall: async (id) => { await window.api.invoke('emulators:uninstall', id); await get().refresh() },
  locate: async (id) => { if (await window.api.invoke('emulators:locate', id)) await get().refresh() },
  check: async () => {
    set({ checking: true })
    try {
      const res: LatestVersion[] = await window.api.invoke('emulators:check')
      set({ latest: Object.fromEntries(res.map((r) => [r.id, r.version])) })
    } finally { set({ checking: false }) }
  },
  play: (entryId) => window.api.invoke('game:play', entryId),
  listen: () => {
    const off1 = window.api.on('emulators:progress', (p) => set((s) => (s.progress[p.id] ? { progress: { ...s.progress, [p.id]: p } } : s)))
    const off2 = window.api.on('game:session', (g) => {
      set((s) => ({ running: g.running ? [...new Set([...s.running, g.entryId])] : s.running.filter((x) => x !== g.entryId) }))
      if (!g.running) void import('./library').then((m) => m.useLibrary.getState().refresh())
    })
    return () => { off1(); off2() }
  }
}))
