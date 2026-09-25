import { create } from 'zustand'

export type Route = 'home' | 'catalog' | 'library' | 'emulators' | 'settings'
interface AppState { route: Route; go: (r: Route) => void }
export const useApp = create<AppState>((set) => ({ route: 'library', go: (route) => set({ route }) }))
