import { create } from 'zustand'
import type { Collection, ImportResult, LibraryEntry, LibraryProgress } from '@shared/library'

type RemoveAction = 'file' | 'entry' | 'save' | 'all'

interface LibraryState {
  entries: LibraryEntry[]
  collections: Collection[]
  /** Incrémenté quand les sauvegardes d'un jeu changent hors du panneau (suppression) : le panneau se recharge. */
  savesRev: number
  /** Incrémenté à chaque rechargement de la liste : les vues qui lisent les modifications d'un jeu (titre, description…) se rechargent. */
  rev: number
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
  /** Retire toutes les entrées de la bibliothèque (Réglages → Zone dangereuse) ; les fichiers ROM ne sont pas touchés. */
  clearAll: () => Promise<void>
  /** Supprime le fichier ROM de tous les jeux (Réglages → Zone dangereuse) ; les entrées restent, marquées sans fichier. */
  deleteAllFiles: () => Promise<void>
  setFlag: (id: number, flags: { favorite?: boolean; pinned?: boolean }) => Promise<void>
  /** Crée une collection et renvoie son id (null si le nom est vide). */
  createCollection: (name: string) => Promise<number | null>
  renameCollection: (id: number, name: string) => Promise<boolean>
  deleteCollection: (id: number) => Promise<void>
  setMember: (collectionId: number, entryId: number, member: boolean) => Promise<void>
  setMembers: (collectionId: number, entryIds: number[]) => Promise<void>
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
    entries: [], collections: [], savesRev: 0, rev: 0, loaded: false, busy: false, progress: null, result: null,
    refresh: async () => {
      const [entries, collections] = await Promise.all([window.api.invoke('library:list'), window.api.invoke('collections:list')])
      set({ entries, collections, loaded: true, rev: get().rev + 1 })
    },
    importPaths: (paths) => (paths.length ? run(() => window.api.invoke('library:import', { paths })) : Promise.resolve()),
    link: async () => { await get().importPaths(await window.api.invoke('library:pick', 'files')) },
    scan: () => run(() => window.api.invoke('library:scan')),
    add: async (gameId) => { await window.api.invoke('library:add', gameId); await get().refresh() },
    removeEntry: async (id, action) => { await window.api.invoke('library:remove', { id, action }); set({ savesRev: get().savesRev + 1 }); await get().refresh() },
    clearAll: async () => { await window.api.invoke('library:clearAll'); await get().refresh() },
    deleteAllFiles: async () => { await window.api.invoke('library:deleteAllFiles'); await get().refresh() },
    setFlag: async (id, flags) => {
      // Mise à jour immédiate de la liste (le cœur réagit au clic), puis l'enregistrement.
      set({ entries: get().entries.map((e) => (e.id === id ? { ...e, ...flags } : e)) })
      await window.api.invoke('library:flag', { id, ...flags })
    },
    createCollection: async (name) => { const c = await window.api.invoke('collections:create', name); await get().refresh(); return c?.id ?? null },
    renameCollection: async (id, name) => { const ok = await window.api.invoke('collections:rename', { id, name }); await get().refresh(); return ok },
    deleteCollection: async (id) => { await window.api.invoke('collections:delete', id); await get().refresh() },
    setMember: async (collectionId, entryId, member) => { await window.api.invoke('collections:set', { collectionId, entryId, member }); await get().refresh() },
    setMembers: async (collectionId, entryIds) => { await window.api.invoke('collections:setMembers', { collectionId, entryIds }); await get().refresh() },
    dismissResult: () => { clearTimeout(dismissTimer); set({ result: null }) }
  }
})
