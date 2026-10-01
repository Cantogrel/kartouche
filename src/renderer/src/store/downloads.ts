import { create } from 'zustand'
import type { DownloadProgress } from '@shared/downloads'

interface DownloadJob extends DownloadProgress { label: string }

interface DownloadsState {
  /** Téléchargements en cours (`sourceId` → avancement), lus par la barre d'état et par le bouton Télécharger. */
  jobs: Record<number, DownloadJob>
  start: (sourceId: number, label: string) => Promise<{ ok: boolean; error?: string }>
  cancel: (sourceId: number) => void
  listen: () => () => void
}

/** Store global (pas un état local du bouton) : le téléchargement continue si on quitte la fiche du jeu, et la
 * barre d'état en bas de l'app doit pouvoir le montrer quelle que soit la page affichée. */
export const useDownloads = create<DownloadsState>((set, get) => ({
  jobs: {},
  start: async (sourceId, label) => {
    if (get().jobs[sourceId]) return { ok: false, error: 'busy' }
    set((s) => ({ jobs: { ...s.jobs, [sourceId]: { sourceId, phase: 'downloading', done: 0, total: 0, label } } }))
    try {
      return await window.api.invoke('downloads:start', sourceId)
    } catch (e) {
      // Le canal IPC lui-même ne devrait jamais rejeter (voir le try/catch de downloads:start côté main), mais un
      // filet ici évite qu'un cas imprévu fasse disparaître le téléchargement sans aucun message à l'écran.
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      set((s) => { const jobs = { ...s.jobs }; delete jobs[sourceId]; return { jobs } })
    }
  },
  cancel: (sourceId) => void window.api.invoke('downloads:cancel', sourceId),
  listen: () => window.api.on('download:progress', (p) =>
    set((s) => (s.jobs[p.sourceId] ? { jobs: { ...s.jobs, [p.sourceId]: { ...s.jobs[p.sourceId], ...p } } } : s))
  )
}))
