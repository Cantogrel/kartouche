import { create } from 'zustand'
import type { DownloadProgress } from '@shared/downloads'

interface DownloadJob extends DownloadProgress { label: string; gameId?: number }

interface DownloadsState {
  /** Téléchargements en cours (`sourceId` → avancement), lus par la barre d'état et par le bouton Télécharger. */
  jobs: Record<number, DownloadJob>
  /** Dernier échec par source, conservé hors du composant (la fiche peut être quittée puis rouverte) jusqu'à fermeture ou nouvel essai. */
  errors: Record<number, string>
  dismissError: (sourceId: number) => void
  start: (sourceId: number, label: string, gameId?: number) => Promise<{ ok: boolean; error?: string }>
  cancel: (sourceId: number) => void
  listen: () => () => void
}

/** Store global (pas un état local du bouton) : le téléchargement continue si on quitte la fiche du jeu, et la
 * barre d'état en bas de l'app doit pouvoir le montrer quelle que soit la page affichée. */
export const useDownloads = create<DownloadsState>((set, get) => ({
  jobs: {},
  errors: {},
  dismissError: (sourceId) => set((s) => { const errors = { ...s.errors }; delete errors[sourceId]; return { errors } }),
  start: async (sourceId, label, gameId) => {
    if (get().jobs[sourceId]) return { ok: false, error: 'busy' }
    set((s) => { const errors = { ...s.errors }; delete errors[sourceId]; return { errors, jobs: { ...s.jobs, [sourceId]: { sourceId, phase: 'downloading', done: 0, total: 0, label, gameId } } } })
    try {
      const r = await window.api.invoke('downloads:start', sourceId)
      // Une annulation voulue n'est pas un échec ; sinon toujours un message, même si le main n'en a pas fourni.
      if (!r.ok && r.error !== 'annulé') set((s) => ({ errors: { ...s.errors, [sourceId]: r.error || 'unknown' } }))
      return r
    } catch (e) {
      // Le canal IPC lui-même ne devrait jamais rejeter (voir le try/catch de downloads:start côté main), mais un
      // filet ici évite qu'un cas imprévu fasse disparaître le téléchargement sans aucun message à l'écran.
      const error = e instanceof Error ? e.message : String(e)
      set((s) => ({ errors: { ...s.errors, [sourceId]: error } }))
      return { ok: false, error }
    } finally {
      set((s) => { const jobs = { ...s.jobs }; delete jobs[sourceId]; return { jobs } })
    }
  },
  cancel: (sourceId) => void window.api.invoke('downloads:cancel', sourceId),
  listen: () => window.api.on('download:progress', (p) =>
    set((s) => (s.jobs[p.sourceId] ? { jobs: { ...s.jobs, [p.sourceId]: { ...s.jobs[p.sourceId], ...p } } } : s))
  )
}))
