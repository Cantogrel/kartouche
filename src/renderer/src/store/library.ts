import { create } from 'zustand'
import type { ImportResult, LibraryEntry, LibraryProgress } from '@shared/library'

type RemoveAction = 'file' | 'entry' | 'save' | 'all'

interface LibraryState {
  entries: LibraryEntry[]
  loaded: boolean
  busy: boolean
  progress: LibraryProgress | null
  /** Bilan du dernier import, affiché quelques secondes puis retiré (ou fermé par l'utilisateur). */
  result: ImportResult | null
  refresh: () => Promise<void>
  importPaths: (paths: string[]) => Promise<void>
  /** Choisit des fichiers dans l'Explorateur et les importe (rattache la ROM à un jeu sans fichier si elle correspond). */
  link: () => Promise<void>
  scan: () => Promise<void>
  add: (gameId: number) => Promise<void>
  removeEntry: (id: number, action: RemoveAction) => Promise<void>
  dismissResult: () => void
}

let dismissTimer: ReturnType<typeof setTimeout> | undefined

export const useLibrary = create<LibraryState>((set, get) => {
  const run = async (job: () => Promise<ImportResult>): Promise<void> => {
    if (get().busy) return
    set({ busy: true, progress: null, result: null })
    const off = window.api.on('library:progress', (progress) => set({ progress }))
    try {
      const result = await job()
      // La liste est rafraîchie AVANT d'annoncer le résultat : le jeu est déjà là quand la notification apparaît.
      await get().refresh()
      set({ result })
      clearTimeout(dismissTimer)
      dismissTimer = setTimeout(() => set({ result: null }), result.items.every((i) => i.status === 'added') ? 5000 : 12000)
    } finally { off(); set({ busy: false, progress: null }) }
  }
  return {
    entries: [], loaded: false, busy: false, progress: null, result: null,
    refresh: async () => { set({ entries: await window.api.invoke('library:list'), loaded: true }) },
    importPaths: (paths) => (paths.length ? run(() => window.api.invoke('library:import', { paths })) : Promise.resolve()),
    link: async () => { await get().importPaths(await window.api.invoke('library:pick', 'files')) },
    scan: () => run(() => window.api.invoke('library:scan')),
    add: async (gameId) => { await window.api.invoke('library:add', gameId); await get().refresh() },
    removeEntry: async (id, action) => { await window.api.invoke('library:remove', { id, action }); await get().refresh() },
    dismissResult: () => { clearTimeout(dismissTimer); set({ result: null }) }
  }
})
