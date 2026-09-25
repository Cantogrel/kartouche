import { create } from 'zustand'
import type { CatalogSort } from '@shared/catalog'

/** Filtres du catalogue, conservés quand on ouvre une fiche puis qu'on revient. */
export interface CatalogView { consoles: string[]; genres: string[]; sort: CatalogSort; /** null = sens par défaut du critère */ dir: 'asc' | 'desc' | null; variants: boolean; limit: number }

export type Route = 'home' | 'catalog' | 'library' | 'emulators' | 'settings' | 'game'
interface Loc { route: Route; gameId?: string }
interface AppState extends Loc {
  history: Loc[]
  librarySearch: string
  catalog: CatalogView
  /** Titre de la page quand il ne vient pas de la navigation (fiche d'un jeu du catalogue). */
  pageTitle: string | null
  setCatalog: (patch: Partial<CatalogView>) => void
  setPageTitle: (t: string | null) => void
  go: (r: Route, gameId?: string) => void
  back: () => void
  setLibrarySearch: (s: string) => void
}

/** Route initiale depuis le hash (#catalog, #game/oot) : pratique pour les tests visuels. */
function initialLoc(): Loc {
  const [r, id] = location.hash.slice(1).split('/')
  const ok: Route[] = ['home', 'catalog', 'library', 'emulators', 'settings', 'game']
  return ok.includes(r as Route) ? { route: r as Route, gameId: id } : { route: 'library' }
}

export const useApp = create<AppState>((set, get) => ({
  ...initialLoc(), history: [], librarySearch: '', pageTitle: null,
  catalog: { consoles: [], genres: [], sort: 'popularity', dir: null, variants: false, limit: 60 },
  setCatalog: (patch) => set({ catalog: { ...get().catalog, ...patch } }),
  setPageTitle: (pageTitle) => set({ pageTitle }),
  // D'une fiche à une autre (liste latérale) on remplace au lieu d'empiler : « retour » ramène à la page d'origine, pas à la fiche précédente.
  go: (route, gameId) => set({ pageTitle: null, history: route === 'game' && get().route === 'game' ? get().history : [...get().history, { route: get().route, gameId: get().gameId }], route, gameId }),
  back: () => {
    const h = get().history
    const prev = h[h.length - 1]
    if (prev) set({ ...prev, pageTitle: null, history: h.slice(0, -1) })
  },
  setLibrarySearch: (librarySearch) => set({ librarySearch })
}))
