import type { Settings } from './settings'
import type { Collection, ImportRequest, ImportResult, LibraryContentItem, LibraryEntry, LibraryProgress, SbiImportResult } from './library'
import type { AchievementsResult } from './achievements'
import type { BackupInfo, SaveInfo } from './saves'
import type { BiosImportResult, BiosSlotStatus } from './bios'
import type { EmulatorProgress, EmulatorState, GameSession, LatestVersion, LaunchResult } from './emulators'
import type { CatalogGame, CatalogPage, CatalogQuery, GameDetails, ProviderStatus, SyncProgress, SyncResult } from './catalog'
import type { SourceListImportResult, SourceListRefreshResult } from './sourceList'

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
  /** Thème système au démarrage (Windows clair/sombre) ; les changements en cours d'exécution arrivent par l'événement 'theme:osDark'. */
  osDark: boolean
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
  /** Remet à zéro réglages, bibliothèque, catalogue et collections (garde les fichiers ROM et les émulateurs installés) ; redémarre l'app aussitôt. */
  'app:factoryReset': { req: void; res: void }
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
  'library:remove': { req: { id: number; action: 'file' | 'entry' | 'save' | 'all' }; res: void }
  /** Vide entièrement la bibliothèque (toutes les entrées) ; les fichiers ROM ne sont pas touchés. */
  'library:clearAll': { req: void; res: void }
  /** Supprime le fichier ROM de tous les jeux de la bibliothèque ; les entrées restent, marquées sans fichier. */
  'library:deleteAllFiles': { req: void; res: void }
  /** Ajoute un jeu du catalogue à la bibliothèque, sans fichier. */
  'library:add': { req: number; res: LibraryEntry | null }
  /** Affiche la ROM dans l'Explorateur. */
  'library:reveal': { req: number; res: void }
  /** Mises à jour/DLC Switch rattachés à ce jeu (détectés par Title ID à l'import). */
  'library:content': { req: number; res: LibraryContentItem[] }
  /** Affiche le dossier des mises à jour/DLC rattachés dans l'Explorateur. */
  'library:revealContent': { req: number; res: void }
  /** Favori et/ou épingle d'un jeu (champ absent = inchangé). */
  'library:flag': { req: { id: number; favorite?: boolean; pinned?: boolean }; res: void }
  /** Ouvre le sélecteur pour un fichier .sbi ; null si annulé. */
  'library:pickSbi': { req: void; res: string | null }
  /** Copie un .sbi à côté de la ROM d'un jeu (protection libcrypt PS1). */
  'library:importSbi': { req: { entryId: number; path: string }; res: SbiImportResult }
  'collections:list': { req: void; res: Collection[] }
  /** Crée une collection (renvoie l'existante si le nom est déjà pris) ; null si le nom est vide. */
  'collections:create': { req: string; res: Collection | null }
  /** false si le nom est vide ou déjà pris. */
  'collections:rename': { req: { id: number; name: string }; res: boolean }
  'collections:delete': { req: number; res: void }
  /** Ajoute (member = true) ou retire un jeu d'une collection. */
  'collections:set': { req: { collectionId: number; entryId: number; member: boolean }; res: void }
  /** Remplace la liste des jeux d'une collection. */
  'collections:setMembers': { req: { collectionId: number; entryIds: number[] }; res: void }
  /** Sauvegardes du jeu (fichiers trouvés, copies) ; null si l'émulateur est inconnu. */
  'saves:info': { req: number; res: SaveInfo | null }
  'saves:backup': { req: number; res: BackupInfo | null }
  'saves:restore': { req: { entryId: number; name: string }; res: boolean }
  'saves:deleteBackup': { req: { entryId: number; name: string }; res: void }
  /** Supprime toutes les copies ; renvoie leur nombre. */
  'saves:deleteAllBackups': { req: number; res: number }
  /** Ouvre le dossier des sauvegardes dans l'Explorateur. */
  'saves:open': { req: number; res: void }
  'achievements:get': { req: { entryId: number; refresh?: boolean }; res: AchievementsResult }
  /** Ajoute une liste de sources (URL JSON apportée par l'utilisateur) ; rapproche ses entrées du catalogue. */
  'sourceLists:add': { req: string; res: SourceListImportResult }
  /** Re-télécharge et revalide une liste ; un échec conserve les sources déjà importées. */
  'sourceLists:refresh': { req: number; res: SourceListRefreshResult }
  /** Retire une liste et ses sources (les autres listes ne sont pas touchées). */
  'sourceLists:remove': { req: number; res: void }
  'emulators:list': { req: void; res: EmulatorState[] }
  /** Télécharge et installe (ou met à jour) un émulateur ; la progression arrive par 'emulators:progress'. */
  'emulators:install': { req: string; res: { ok: boolean; error?: string } }
  'emulators:uninstall': { req: string; res: void }
  /** Indique à la main l'exécutable d'un émulateur déjà installé ; null si annulé. */
  'emulators:locate': { req: string; res: EmulatorState | null }
  /** Interroge les sources pour connaître la dernière version de chaque émulateur installé. */
  'emulators:check': { req: void; res: LatestVersion[] }
  /** Ouvre l'émulateur seul ('app'), son dossier ('dir') ou son dossier de BIOS ('bios'). */
  'emulators:open': { req: { id: string; what: 'app' | 'dir' | 'bios' }; res: LaunchResult }
  /** État des BIOS / firmwares / clés de tous les émulateurs. */
  'bios:status': { req: void; res: BiosSlotStatus[] }
  /** Sélecteur de fichiers pour les BIOS d'un émulateur ; renvoie les chemins choisis. */
  'bios:pick': { req: string; res: string[] }
  /** Reconnaît, valide et place les fichiers fournis (glisser-déposer ou sélecteur). */
  'bios:import': { req: { emulator: string; paths: string[] }; res: BiosImportResult[] }
  /** Télécharge le firmware depuis la source officielle du constructeur (PS3, Vita) et l'installe ; progression par 'emulators:progress'. */
  'bios:auto': { req: string; res: BiosImportResult }
  /** Retire un BIOS / firmware / clé installé ; true si retiré. */
  'bios:remove': { req: string; res: boolean }
  'game:play': { req: number; res: LaunchResult }
  /** Ferme le jeu proprement (fermeture des fenêtres de l'émulateur, de force au bout de 5 s). */
  'game:stop': { req: number; res: void }
  'game:running': { req: void; res: number[] }
  'providers:status': { req: void; res: ProviderStatus[] }
  'update:state': { req: void; res: UpdateState }
  'update:check': { req: void; res: UpdateState }
  'update:download': { req: void; res: void }
  /** Ferme l'app et installe la mise à jour téléchargée. */
  'update:install': { req: void; res: void }
  /** Notes de la dernière mise à jour installée (pour le bouton « voir le changelog » des Paramètres) ; null si aucune. */
  'update:lastChangelog': { req: void; res: UpdateChangelog }
  /** Comme `update:lastChangelog`, mais seulement si ce changelog n'a pas déjà été montré pour la version en cours ; le marque montré. */
  'update:pendingChangelog': { req: void; res: UpdateChangelog }
}

export interface UpdateState {
  /** unavailable = app non installée (développement). */
  status: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error' | 'unavailable'
  version: string | null
  percent: number
  error: string | null
}

/** Notes de version (texte du release GitHub) de la dernière mise à jour téléchargée. */
export type UpdateChangelog = { version: string; notes: string } | null

/** Événements poussés main → renderer. */
export interface IpcEvents {
  'catalog:progress': SyncProgress
  'library:progress': LibraryProgress
  'emulators:progress': EmulatorProgress
  'game:session': GameSession
  'update:state': UpdateState
  /** Le thème clair/sombre de Windows a changé pendant que l'app tourne (réglage 'auto' uniquement). */
  'theme:osDark': boolean
}
export type IpcChannel = keyof IpcChannels

export interface RomVaultApi {
  invoke<C extends IpcChannel>(channel: C, req?: IpcChannels[C]['req']): Promise<IpcChannels[C]['res']>
  on<E extends keyof IpcEvents>(event: E, cb: (payload: IpcEvents[E]) => void): () => void
  window: { minimize(): void; maximize(): void; close(): void; fullscreen(on: boolean): void }
  /** Chemin réel d'un fichier déposé (File.path n'existe plus dans Electron récent). */
  pathOf(file: File): string
}
