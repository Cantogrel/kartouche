import type { Settings } from './settings'
import type { CatalogGame, CatalogPage, CatalogQuery, GameDetails, ProviderStatus, SyncProgress, SyncResult } from './catalog'

export interface AppPaths {
  dataDir: string
  roms: string
  emulators: string
  bios: string
  saves: string
  cache: string
  dats: string
  logs: string
}

export interface AppInfo {
  version: string
  osLocale: string
  sqlite: string
  paths: AppPaths
}

/** Canaux invoke (renderer → main) : requête et réponse typées, source unique de vérité. */
export interface IpcChannels {
  'app:info': { req: void; res: AppInfo }
  'settings:get': { req: void; res: Settings }
  'settings:set': { req: Partial<Settings>; res: Settings }
  /** Ouvre le sélecteur de dossier ; le changement prend effet au redémarrage. */
  'paths:chooseDataDir': { req: void; res: { dataDir: string; restartRequired: boolean } | null }
  'paths:openDataDir': { req: void; res: void }
  'app:relaunch': { req: void; res: void }
  'catalog:search': { req: CatalogQuery; res: CatalogPage }
  'catalog:get': { req: number; res: CatalogGame | null }
  'catalog:details': { req: { id: number; refresh?: boolean }; res: GameDetails | null }
  'catalog:sync': { req: string[] | undefined; res: SyncResult }
  'catalog:status': { req: void; res: { total: number; syncedAt: number | null; syncing: boolean } }
  'providers:status': { req: void; res: ProviderStatus[] }
}

/** Événements poussés main → renderer. */
export interface IpcEvents {
  'catalog:progress': SyncProgress
}
export type IpcChannel = keyof IpcChannels

export interface RomVaultApi {
  invoke<C extends IpcChannel>(channel: C, req?: IpcChannels[C]['req']): Promise<IpcChannels[C]['res']>
  on<E extends keyof IpcEvents>(event: E, cb: (payload: IpcEvents[E]) => void): () => void
  window: { minimize(): void; maximize(): void; close(): void }
}
