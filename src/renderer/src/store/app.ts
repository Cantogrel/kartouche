import { create } from 'zustand'
import type { CatalogSort } from '@shared/catalog'

/** Filtres du catalogue, conservés quand on ouvre une fiche puis qu'on revient. */
export interface CatalogView { consoles: string[]; genres: string[]; sort: CatalogSort; /** null = sens par défaut du critère */ dir: 'asc' | 'desc' | null; variants: boolean; limit: number }

/** Onglet de la Bibliothèque : un filtre fixe ou `c<id>` pour une collection. */
export type LibraryTab = 'all' | 'ready' | 'missing' | 'favorites' | `c${number}`
/** Filtres de la Bibliothèque, conservés quand on ouvre une fiche puis qu'on revient. */
export interface LibraryView { tab: LibraryTab; consoleFilter: string | null }

export type Route = 'home' | 'catalog' | 'library' | 'emulators' | 'settings' | 'game'
/** `gameId` = id du jeu pour la route `game` ; section de départ (ex. `about`) pour la route `settings`. */
interface Loc { route: Route; gameId?: string }
interface AppState extends Loc {
  history: Loc[]
  librarySearch: string
  catalog: CatalogView
  library: LibraryView
  /** Titre de la page quand il ne vient pas de la navigation (fiche d'un jeu du catalogue). */
  pageTitle: string | null
  /** Mode Big Picture (plein écran, manette). */
  bigPicture: boolean
  setBigPicture: (on: boolean) => void
  setCatalog: (patch: Partial<CatalogView>) => void
  setLibraryView: (patch: Partial<LibraryView>) => void
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
  ...initialLoc(), history: [], librarySearch: '', pageTitle: null, bigPicture: location.hash === '#bigpicture',
  setBigPicture: (bigPicture) => set({ bigPicture }),
  catalog: { consoles: [], genres: [], sort: 'popularity', dir: null, variants: false, limit: 60 },
  setCatalog: (patch) => set({ catalog: { ...get().catalog, ...patch } }),
  library: { tab: 'all', consoleFilter: null },
  setLibraryView: (patch) => set({ library: { ...get().library, ...patch } }),
  setPageTitle: (pageTitle) => set({ pageTitle }),
  // D'une fiche à une autre (liste latérale) on remplace au lieu d'empiler : « retour » ramène à la page d'origine, pas à la fiche précédente.
  // Re-cliquer sur la fiche déjà ouverte (menu de gauche) ne doit rien changer : sinon pageTitle repasse à null sans
  // que l'effet qui le renseigne ne se redéclenche (id/entry inchangés), et le titre retombe sur celui de la route.
  go: (route, gameId) => {
    if (route === get().route && gameId === get().gameId) return
    set({ pageTitle: null, history: route === 'game' && get().route === 'game' ? get().history : [...get().history, { route: get().route, gameId: get().gameId }], route, gameId })
  },
  back: () => {
    const h = get().history
    const prev = h[h.length - 1]
    if (prev) set({ ...prev, pageTitle: null, history: h.slice(0, -1) })
  },
  setLibrarySearch: (librarySearch) => set({ librarySearch })
}))
