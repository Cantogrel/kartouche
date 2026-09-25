import type { Settings } from './settings'
import type { ImportRequest, ImportResult, LibraryEntry, LibraryProgress } from './library'
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
  'catalog:status': { req: void; res: { total: number; syncedAt: number | null; syncing: boolean; enriched: boolean } }
  /** Passe IGDB (si configuré) : popularité, genre, développeur, année ; renvoie le nombre de jeux rapprochés. */
  'catalog:popularity': { req: void; res: number }
  'library:list': { req: void; res: LibraryEntry[] }
  /** Importe des fichiers/dossiers (glisser-déposer : chemins fournis par le renderer). */
  'library:import': { req: ImportRequest; res: ImportResult }
  /** Ouvre le sélecteur de fichiers ou de dossier ; renvoie les chemins choisis (vide si annulé). */
  'library:pick': { req: 'files' | 'folder'; res: string[] }
  /** Réimporte (en référence, sans copie) les dossiers surveillés des réglages et met à jour les fichiers manquants. */
  'library:scan': { req: void; res: ImportResult }
  'library:remove': { req: { id: number; deleteFile: boolean }; res: void }
  'providers:status': { req: void; res: ProviderStatus[] }
}

/** Événements poussés main → renderer. */
export interface IpcEvents {
  'catalog:progress': SyncProgress
  'library:progress': LibraryProgress
}
export type IpcChannel = keyof IpcChannels

export interface RomVaultApi {
  invoke<C extends IpcChannel>(channel: C, req?: IpcChannels[C]['req']): Promise<IpcChannels[C]['res']>
  on<E extends keyof IpcEvents>(event: E, cb: (payload: IpcEvents[E]) => void): () => void
  window: { minimize(): void; maximize(): void; close(): void }
  /** Chemin réel d'un fichier déposé (File.path n'existe plus dans Electron récent). */
  pathOf(file: File): string
}
