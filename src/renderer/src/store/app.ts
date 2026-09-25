import { create } from 'zustand'

export type Route = 'home' | 'catalog' | 'library' | 'emulators' | 'settings' | 'game'
interface Loc { route: Route; gameId?: string }
interface AppState extends Loc {
  history: Loc[]
  librarySearch: string
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
  ...initialLoc(), history: [], librarySearch: '',
  go: (route, gameId) => set({ history: [...get().history, { route: get().route, gameId: get().gameId }], route, gameId }),
  back: () => {
    const h = get().history
    const prev = h[h.length - 1]
    if (prev) set({ ...prev, history: h.slice(0, -1) })
  },
  setLibrarySearch: (librarySearch) => set({ librarySearch })
}))
