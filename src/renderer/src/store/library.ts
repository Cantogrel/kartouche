import { create } from 'zustand'
import type { ImportResult, LibraryEntry, LibraryProgress } from '@shared/library'

interface LibraryState {
  entries: LibraryEntry[]
  loaded: boolean
  busy: boolean
  progress: LibraryProgress | null
  /** Bilan du dernier import, affiché jusqu'à ce que l'utilisateur le ferme. */
  result: ImportResult | null
  refresh: () => Promise<void>
  importPaths: (paths: string[]) => Promise<void>
  scan: () => Promise<void>
  remove: (id: number, deleteFile: boolean) => Promise<void>
  dismissResult: () => void
}

export const useLibrary = create<LibraryState>((set, get) => {
  const run = async (job: () => Promise<ImportResult>): Promise<void> => {
    if (get().busy) return
    set({ busy: true, progress: null, result: null })
    const off = window.api.on('library:progress', (progress) => set({ progress }))
    try { set({ result: await job() }) } finally { off(); set({ busy: false, progress: null }); await get().refresh() }
  }
  return {
    entries: [], loaded: false, busy: false, progress: null, result: null,
    refresh: async () => { set({ entries: await window.api.invoke('library:list'), loaded: true }) },
    importPaths: (paths) => (paths.length ? run(() => window.api.invoke('library:import', { paths })) : Promise.resolve()),
    scan: () => run(() => window.api.invoke('library:scan')),
    remove: async (id, deleteFile) => { await window.api.invoke('library:remove', { id, deleteFile }); await get().refresh() },
    dismissResult: () => set({ result: null })
  }
})
