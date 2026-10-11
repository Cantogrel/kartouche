import { create } from 'zustand'
import type { EmulatorProgress, EmulatorState, LatestVersion, LaunchResult, QuickExit } from '@shared/emulators'

interface EmulatorsState {
  list: EmulatorState[]
  loaded: boolean
  progress: Record<string, EmulatorProgress>
  errors: Record<string, string>
  /** Émulateurs en cours de désinstallation : le bouton est bloqué et la barre d'état l'indique. */
  removing: Record<string, true>
  /** Firmware installé seul (bouton « Installer automatiquement »), hors installation de l'émulateur : tâche en cours dans la barre d'état. */
  firmware: Record<string, EmulatorProgress>
  latest: Record<string, string | null>
  checking: boolean
  /** Jeux (ids de la bibliothèque) actuellement ouverts dans un émulateur. */
  running: number[]
  /** Clic sur Jouer en cours de traitement (avant même que le jeu démarre) : install Vita3K en amont, par ex., peut prendre plusieurs minutes. */
  launching: number[]
  /** Dernière fermeture suspecte (probable échec de lancement) par jeu ; effacée au lancement suivant. */
  quickExits: Record<number, QuickExit>
  refresh: () => Promise<void>
  /** Faux si l'installation a échoué ou a été annulée (`errors[id]` vide dans ce dernier cas). */
  install: (id: string) => Promise<boolean>
  cancelInstall: (id: string) => void
  uninstall: (id: string) => Promise<void>
  /** Désinstalle tous les émulateurs installés (Réglages → Zone dangereuse). */
  uninstallAll: () => Promise<void>
  locate: (id: string) => Promise<void>
  /** Recherche des mises à jour ; renvoie faux si au moins un émulateur n'a pas pu être vérifié (réseau, GitHub…). */
  check: () => Promise<boolean>
  /** Recherche automatique, sans message : au démarrage (une nouvelle tentative 10 s plus tard en cas d'échec) puis toutes les 6 h ; le résultat se voit dans l'onglet Émulateurs. Renvoie l'arrêt. */
  autoCheck: () => () => void
  play: (entryId: number) => Promise<LaunchResult>
  dismissQuickExit: (entryId: number) => void
  listen: () => () => void
}

export const useEmulators = create<EmulatorsState>((set, get) => ({
  list: [], loaded: false, progress: {}, errors: {}, removing: {}, firmware: {}, latest: {}, checking: false, running: [], launching: [], quickExits: {},
  refresh: async () => {
    const [list, running] = await Promise.all([window.api.invoke('emulators:list'), window.api.invoke('game:running')])
    set({ list, running, loaded: true })
  },
  install: async (id) => {
    if (get().progress[id]) return false
    set((s) => ({ progress: { ...s.progress, [id]: { id, phase: 'resolve', done: 0, total: 0 } }, errors: { ...s.errors, [id]: '' } }))
    const res = await window.api.invoke('emulators:install', id)
    set((s) => {
      const progress = { ...s.progress }
      delete progress[id]
      return { progress, errors: { ...s.errors, [id]: res.ok || res.error === 'canceled' ? '' : res.error ?? 'error' } }
    })
    await get().refresh()
    return res.ok
  },
  cancelInstall: (id) => void window.api.invoke('emulators:cancel', id),
  uninstall: async (id) => {
    if (get().removing[id]) return
    set((s) => ({ removing: { ...s.removing, [id]: true } }))
    try { await window.api.invoke('emulators:uninstall', id) } finally {
      set((s) => { const removing = { ...s.removing }; delete removing[id]; return { removing } })
    }
    await get().refresh()
  },
  uninstallAll: async () => {
    for (const e of get().list.filter((e) => e.installed)) await get().uninstall(e.id)
  },
  locate: async (id) => { if (await window.api.invoke('emulators:locate', id)) await get().refresh() },
  check: async () => {
    if (get().checking) return true
    set({ checking: true })
    try {
      const res: LatestVersion[] = await window.api.invoke('emulators:check')
      // Un émulateur dont la vérification échoue garde sa dernière version connue.
      set((s) => ({ latest: { ...s.latest, ...Object.fromEntries(res.filter((r) => r.version).map((r) => [r.id, r.version])) } }))
      return res.every((r) => !r.error)
    } catch { return false } finally { set({ checking: false }) }
  },
  autoCheck: () => {
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const run = async (again: boolean): Promise<void> => {
      const ok = await get().check()
      if (!ok && again && !stopped) retry = setTimeout(() => void run(false), 10_000)
    }
    void run(true)
    const every = setInterval(() => void run(false), 6 * 3600 * 1000)
    return () => { stopped = true; clearTimeout(retry); clearInterval(every) }
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
    const off1 = window.api.on('emulators:progress', (p) => set((s) => {
      if (s.progress[p.id]) return { progress: { ...s.progress, [p.id]: p } }
      // Hors installation de l'émulateur : c'est le firmware officiel installé seul ; la tâche s'arrête à « done » (émis quoi qu'il arrive).
      const firmware = { ...s.firmware }
      if (p.phase === 'done' || p.phase === 'error') delete firmware[p.id]
      else firmware[p.id] = p
      return { firmware }
    }))
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
