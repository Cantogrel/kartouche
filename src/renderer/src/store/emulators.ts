import { create } from 'zustand'
import type { EmulatorProgress, EmulatorState, LatestVersion, LaunchResult, QuickExit } from '@shared/emulators'

interface EmulatorsState {
  list: EmulatorState[]
  loaded: boolean
  progress: Record<string, EmulatorProgress>
  errors: Record<string, string>
  latest: Record<string, string | null>
  checking: boolean
  /** Jeux (ids de la bibliothèque) actuellement ouverts dans un émulateur. */
  running: number[]
  /** Clic sur Jouer en cours de traitement (avant même que le jeu démarre) : install Vita3K en amont, par ex., peut prendre plusieurs minutes. */
  launching: number[]
  /** Dernière fermeture suspecte (probable échec de lancement) par jeu ; effacée au lancement suivant. */
  quickExits: Record<number, QuickExit>
  refresh: () => Promise<void>
  install: (id: string) => Promise<void>
  uninstall: (id: string) => Promise<void>
  /** Désinstalle tous les émulateurs installés (Réglages → Zone dangereuse). */
  uninstallAll: () => Promise<void>
  locate: (id: string) => Promise<void>
  check: () => Promise<void>
  play: (entryId: number) => Promise<LaunchResult>
  dismissQuickExit: (entryId: number) => void
  listen: () => () => void
}

export const useEmulators = create<EmulatorsState>((set, get) => ({
  list: [], loaded: false, progress: {}, errors: {}, latest: {}, checking: false, running: [], launching: [], quickExits: {},
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
  uninstallAll: async () => {
    for (const e of get().list.filter((e) => e.installed)) await window.api.invoke('emulators:uninstall', e.id)
    await get().refresh()
  },
  locate: async (id) => { if (await window.api.invoke('emulators:locate', id)) await get().refresh() },
  check: async () => {
    set({ checking: true })
    try {
      const res: LatestVersion[] = await window.api.invoke('emulators:check')
      set({ latest: Object.fromEntries(res.map((r) => [r.id, r.version])) })
    } finally { set({ checking: false }) }
  },
  play: async (entryId) => {
    get().dismissQuickExit(entryId)
    set((s) => ({ launching: [...s.launching, entryId] }))
    try {
      const r = await window.api.invoke('game:play', entryId)
      // Échec connu avant même le lancement (zip illisible, .cia refusé…) : même vitrine que les fermetures rapides,
      // plutôt qu'un texte perdu à côté du bouton — l'utilisateur ne l'associe pas sinon au bon message.
      if (!r.ok && r.error && r.error !== 'running') {
        set((s) => ({ quickExits: { ...s.quickExits, [entryId]: { elapsedMs: 0, immediate: r.error, log: r.detail } } }))
      }
      return r
    } finally {
      set((s) => ({ launching: s.launching.filter((x) => x !== entryId) }))
    }
  },
  dismissQuickExit: (entryId) => set((s) => {
    if (!(entryId in s.quickExits)) return s
    const quickExits = { ...s.quickExits }
    delete quickExits[entryId]
    return { quickExits }
  }),
  listen: () => {
    const off1 = window.api.on('emulators:progress', (p) => set((s) => (s.progress[p.id] ? { progress: { ...s.progress, [p.id]: p } } : s)))
    const off2 = window.api.on('game:session', (g) => {
      set((s) => ({
        running: g.running ? [...new Set([...s.running, g.entryId])] : s.running.filter((x) => x !== g.entryId),
        quickExits: g.quickExit ? { ...s.quickExits, [g.entryId]: g.quickExit } : s.quickExits
      }))
      if (!g.running) void import('./library').then((m) => m.useLibrary.getState().refresh())
    })
    return () => { off1(); off2() }
  }
}))
