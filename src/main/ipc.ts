import { app, dialog, globalShortcut, ipcMain, nativeTheme, screen, shell, BrowserWindow } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { IpcChannel, IpcChannels, AppPaths } from '@shared/ipc'
import { loadSettings, loadUserSettings, saveSettings } from './db/settingsStore'
import { setDataDir } from './paths'
import { checkForUpdate, downloadUpdate, installUpdate, lastChangelog, pendingChangelog, updateState } from './updater'
import { catalogCount, getGame, queryCatalog } from './catalog/catalogStore'
import { syncCatalog } from './catalog/sync'
import { getDetails, providerStatus, type MetadataProvider } from './catalog/providers'
import { igdb } from './catalog/igdb'
import { tgdb } from './catalog/tgdb'
import { syncPopularity } from './catalog/popularity'
import { localizeDetails } from './catalog/l10n'
import { importPaths } from './library/importer'
import { addCatalogGame, clearLibrary, deleteAllRomFiles, entryPath, importSbi, listContent, listLibrary, refreshMissing, relinkUnmatched, removeEntry } from './library/libraryStore'
import { createCollection, deleteCollection, listCollections, renameCollection, setFlags, setMembers, setMembership } from './library/collections'
import { backupSaves, deleteAllBackups, deleteBackup, restoreSaves, saveInfo, saveOpenTarget } from './saves/saves'
import { getAchievements } from './achievements/retroachievements'
import { addSourceList } from './sources/import'
import { listSourceLists, refreshSourceList, removeSourceList, sourcesForGame } from './sources/manage'
import { cancelDownload, downloadSource } from './downloads/engine'
import { installDownload } from './downloads/install'
import { ROM_EXTENSIONS } from '@shared/library'
import { resolveLanguage } from '@shared/settings'
import { EMULATORS, emulatorById, type EmulatorState } from '@shared/emulators'
import { installEmulator, uninstallEmulator } from './emulators/installer'
import { latestRelease } from './emulators/source'
import { getRow, listEmulators, saveEmulator } from './emulators/emulatorStore'
import { biosStatus, importBiosFile, removeBios } from './bios/bios'
import { autoInstallFirmware } from './bios/official'
import { isRunning, launchGame, openEmulator, runningCount, stopAllGames, stopGame } from './emulators/launcher'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'

/** Ordre de la cascade de fiches enrichies. */
const PROVIDERS: MetadataProvider[] = [igdb, tgdb]
let syncing = false
/** À incrémenter quand la passe IGDB (popularité, genre, développeur, année) change : elle est alors relancée une fois. */
const ENRICH_VERSION = '2'

type Handler<C extends IpcChannel> = (req: IpcChannels[C]['req']) => IpcChannels[C]['res'] | Promise<IpcChannels[C]['res']>
function handle<C extends IpcChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, (_e, req) => fn(req))
}

/**
 * Resynchronise le catalogue tout seul une fois par version installée (ex. un filtre IGDB corrigé ajoute des jeux
 * à la Switch entre deux versions) : sans ça, rien n'indique à l'utilisateur qu'une actualisation manuelle rendrait
 * de nouvelles fiches disponibles. Sautée si le catalogue est vide (premier lancement, déjà couvert par la synchro
 * auto du renderer) ou si une synchro (manuelle ou déjà déclenchée) est en cours.
 */
export async function autoSyncCatalogOnUpdate(db: DatabaseSync): Promise<void> {
  const version = app.getVersion()
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'catalog:syncedVersion'").get() as { value: string } | undefined
  if (syncing || stored?.value === version || catalogCount(db) === 0) return
  syncing = true
  try {
    await syncCatalog(db, undefined, (p) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('catalog:progress', p)), undefined, loadSettings(db))
    relinkUnmatched(db)
  } finally {
    syncing = false
    db.prepare("INSERT INTO settings (key, value) VALUES ('catalog:syncedVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(version)
  }
}

export function registerIpc(ctx: { db: DatabaseSync; paths: AppPaths; sqliteVersion: string }): void {
  const { db, paths } = ctx
  handle('app:info', () => ({ version: app.getVersion(), osLocale: app.getLocale(), osDark: nativeTheme.shouldUseDarkColors, sqlite: ctx.sqliteVersion, paths }))
  // Réglage « thème » auto : le suivre en direct si l'utilisateur change le thème clair/sombre de Windows pendant que l'app tourne.
  nativeTheme.on('updated', () => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('theme:osDark', nativeTheme.shouldUseDarkColors)))
  handle('update:state', () => updateState())
  handle('update:check', () => checkForUpdate())
  handle('update:download', () => downloadUpdate())
  handle('update:install', () => installUpdate())
  handle('update:lastChangelog', () => lastChangelog(db))
  handle('update:pendingChangelog', () => pendingChangelog(db))
  handle('settings:get', () => loadUserSettings(db))
  handle('settings:set', (patch) => saveSettings(db, patch))
  handle('paths:chooseDataDir', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], defaultPath: paths.dataDir }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    setDataDir(res.filePaths[0])
    return { dataDir: res.filePaths[0], restartRequired: res.filePaths[0] !== paths.dataDir }
  })
  handle('paths:openDataDir', async () => { await shell.openPath(paths.dataDir) })
  handle('app:relaunch', () => { app.relaunch(); app.exit(0) })
  // Ferme la base avant de supprimer son fichier (verrou Windows) : rien d'autre ne doit s'en servir après, d'où le
  // redémarrage immédiat plutôt qu'un état « à redémarrer » comme pour le changement de dossier de données.
  handle('app:factoryReset', async () => {
    db.close()
    const dbFile = join(paths.dataDir, 'romvault.db')
    for (const suffix of ['', '-wal', '-shm']) await rm(dbFile + suffix, { force: true })
    app.relaunch(); app.exit(0)
  })

  handle('catalog:search', (q) => queryCatalog(db, q ?? {}))
  handle('catalog:get', (id) => getGame(db, id))
  handle('catalog:details', async (req) => {
    const game = getGame(db, req.id)
    if (!game) return null
    const s = loadSettings(db)
    // Description dans la langue de l'interface (Wikipédia, sinon traduction automatique), recherchée en même temps que les fournisseurs.
    return localizeDetails(db, game, getDetails(db, game, PROVIDERS, s, { refresh: req.refresh }), resolveLanguage(s.language, app.getLocale()))
  })
  handle('catalog:sync', async (ids) => {
    if (syncing) return { synced: 0, failed: [] }
    syncing = true
    try {
      const result = await syncCatalog(db, ids, (p) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('catalog:progress', p)), undefined, loadSettings(db))
      relinkUnmatched(db)
      return result
    } finally { syncing = false }
  })
  handle('catalog:popularity', async () => {
    const s = loadSettings(db)
    if (!igdb.isConfigured(s) || syncing) return 0
    syncing = true
    try {
      const n = await syncPopularity(db, s, (done, total) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('catalog:progress', { console: 'popularity', done, total })))
      db.prepare("INSERT INTO settings (key, value) VALUES ('_enrich', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ENRICH_VERSION)
      return n
    } catch { return 0 } finally { syncing = false }
  })
  handle('catalog:status', () => {
    const r = db.prepare('SELECT MAX(synced_at) AS at FROM catalog_sync').get() as { at: number | null }
    const e = db.prepare("SELECT value FROM settings WHERE key = '_enrich'").get() as { value: string } | undefined
    return { total: catalogCount(db), syncedAt: r.at, syncing, enriched: e?.value === ENRICH_VERSION }
  })
  const sendLibProgress = (p: unknown): void => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('library:progress', p))
  handle('library:list', () => listLibrary(db))
  handle('library:import', (req) => {
    const s = loadSettings(db)
    return importPaths(db, req.paths, { copy: s.importCopy, deleteSource: req.deleteSource ?? s.importDeleteSource, romsDir: paths.roms }, sendLibProgress)
  })
  handle('library:pick', async (kind) => {
    const win = BrowserWindow.getFocusedWindow()
    // Filtre « ROMs » (extensions connues + zip) en premier, « Tous les fichiers » en repli pour une extension inhabituelle.
    // `multiSelections` combiné à `openDirectory` n'a pas de sens pour un choix de dossier unique : retiré par prudence,
    // sans certitude que ce soit la cause d'un dossier existant que l'utilisateur n'a pas vu dans le sélecteur Windows
    // (aucune anomalie trouvée côté fichiers : pas d'attribut caché/système, pas de redirection du dossier Téléchargements —
    // voir la conversation du 2026-09-29). `defaultPath` : les ROMs de l'utilisateur atterrissent presque toujours dans
    // Téléchargements, où le sélecteur s'ouvrait sinon sur un dossier quelconque laissé par un usage précédent.
    const opts = {
      properties: (kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']) as ('openDirectory' | 'openFile' | 'multiSelections')[],
      defaultPath: app.getPath('downloads'),
      filters: kind === 'folder' ? [] : [{ name: 'ROMs', extensions: [...Object.keys(ROM_EXTENSIONS), 'zip'] }, { name: 'All files', extensions: ['*'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
  })
  handle('library:scan', async () => {
    const r = await importPaths(db, loadSettings(db).scanFolders, { copy: false, deleteSource: false, romsDir: paths.roms }, sendLibProgress)
    refreshMissing(db)
    return r
  })
  handle('library:remove', (req) => removeEntry(db, req.id, req.action, paths.saves))
  handle('library:clearAll', () => clearLibrary(db))
  handle('library:deleteAllFiles', () => deleteAllRomFiles(db))
  handle('library:add', (gameId) => addCatalogGame(db, gameId))
  handle('library:pickSbi', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openFile'] as 'openFile'[], filters: [{ name: 'SBI', extensions: ['sbi'] }] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  handle('library:importSbi', (req) => importSbi(db, req.entryId, req.path))
  handle('library:flag', (req) => setFlags(db, req.id, req))
  handle('collections:list', () => listCollections(db))
  handle('collections:create', (name) => createCollection(db, name))
  handle('collections:rename', (req) => renameCollection(db, req.id, req.name))
  handle('collections:delete', (id) => deleteCollection(db, id))
  handle('collections:set', (req) => setMembership(db, req.collectionId, req.entryId, req.member))
  handle('collections:setMembers', (req) => setMembers(db, req.collectionId, req.entryIds))
  const saveRef = (id: number): { id: number; console: string; path: string } | null =>
    (db.prepare('SELECT id, console, path FROM library WHERE id = ?').get(id) as { id: number; console: string; path: string } | undefined) ?? null
  handle('saves:info', async (id) => { const e = saveRef(id); return e ? saveInfo(db, paths.saves, e) : null })
  handle('saves:backup', async (id) => { const e = saveRef(id); return e ? backupSaves(db, paths.saves, e) : null })
  handle('saves:restore', async (req) => { const e = saveRef(req.entryId); return e && !isRunning(e.id) ? restoreSaves(db, paths.saves, e, req.name) : false })
  handle('saves:deleteBackup', async (req) => { const e = saveRef(req.entryId); if (e) await deleteBackup(db, paths.saves, e, req.name) })
  handle('saves:deleteAllBackups', async (id) => { const e = saveRef(id); return e ? deleteAllBackups(db, paths.saves, e) : 0 })
  handle('saves:open', async (id) => {
    const e = saveRef(id)
    const target = e && (await saveOpenTarget(db, paths.saves, e))
    if (target) { if (target.select) shell.showItemInFolder(target.path); else await shell.openPath(target.path) }
  })
  handle('achievements:get', async (req) => {
    const e = db.prepare('SELECT id, console, title FROM library WHERE id = ?').get(req.entryId) as { id: number; console: string; title: string } | undefined
    if (!e) return { status: 'noMatch' }
    const s = loadSettings(db)
    return getAchievements(db, e, { username: s.raUsername, apiKey: s.raApiKey }, { refresh: req.refresh })
  })
  handle('sourceLists:list', () => listSourceLists(db))
  handle('sources:forGame', (gameId) => sourcesForGame(db, gameId))
  handle('sourceLists:add', (url) => addSourceList(db, url))
  handle('sourceLists:refresh', (id) => refreshSourceList(db, id))
  handle('sourceLists:remove', (id) => removeSourceList(db, id))
  handle('library:reveal', (id) => { const p = entryPath(db, id); if (p) shell.showItemInFolder(p) })
  handle('library:content', (id) => listContent(db, id))
  handle('library:revealContent', (id) => {
    const row = db.prepare('SELECT path FROM library_content WHERE library_id = ? LIMIT 1').get(id) as { path: string } | undefined
    if (row) shell.showItemInFolder(row.path)
  })
  const broadcast = (channel: string, payload: unknown): void => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, payload))
  const downloading = new Set<number>()
  handle('downloads:start', async (sourceId) => {
    if (downloading.has(sourceId)) return { ok: false, error: 'busy' }
    downloading.add(sourceId)
    try {
      const cacheDir = join(paths.cache, 'game-downloads')
      const r = await downloadSource(db, sourceId, cacheDir, (p) => broadcast('download:progress', p))
      if (!r.ok || !r.file) return { ok: false, error: r.error }
      return await installDownload(db, sourceId, r.file, paths)
    } finally { downloading.delete(sourceId) }
  })
  handle('downloads:cancel', (sourceId) => { cancelDownload(sourceId) })
  const installing = new Set<string>()
  handle('emulators:list', () => listEmulators(db))
  handle('emulators:install', async (id) => {
    const def = emulatorById(id)
    if (!def) return { ok: false, error: 'unknown' }
    if (installing.has(id)) return { ok: false, error: 'busy' }
    installing.add(id)
    try {
      const d = screen.getPrimaryDisplay()
      const ctx = { lang: resolveLanguage(loadSettings(db).language, app.getLocale()), displayHeight: Math.round(d.size.height * d.scaleFactor) }
      await installEmulator(db, def, paths, (p) => broadcast('emulators:progress', p), ctx)
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } } finally { installing.delete(id) }
  })
  handle('emulators:uninstall', (id) => uninstallEmulator(db, id))
  handle('emulators:locate', async (id) => {
    const def = emulatorById(id)
    if (!def) return null
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openFile'] as 'openFile'[], filters: [{ name: def.name, extensions: ['exe'] }] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    saveEmulator(db, { id, version: null, dir: dirname(res.filePaths[0]), exe: res.filePaths[0], custom: true })
    return listEmulators(db).find((e) => e.id === id) as EmulatorState
  })
  handle('emulators:check', async () => {
    const installedIds = listEmulators(db).filter((e) => e.installed && !e.custom).map((e) => e.id)
    return Promise.all(installedIds.map(async (id) => {
      try { return { id, version: (await latestRelease(EMULATORS.find((e) => e.id === id)!)).version } } catch (e) { return { id, version: null, error: e instanceof Error ? e.message : String(e) } }
    }))
  })
  handle('emulators:open', async ({ id, what }) => {
    if (what === 'app') return openEmulator(db, id)
    if (what === 'bios') { const d = join(paths.bios, id); mkdirSync(d, { recursive: true }); await shell.openPath(d); return { ok: true } }
    const r = getRow(db, id)
    if (!r) return { ok: false, error: 'notInstalled' }
    await shell.openPath(r.dir)
    return { ok: true }
  })
  handle('bios:status', () => biosStatus({ db, paths }))
  handle('bios:pick', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], filters: [{ name: 'BIOS / firmware', extensions: ['*'] }] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
  })
  handle('bios:import', async ({ emulator, paths: files }) => {
    const out = []
    for (const f of files) out.push(await importBiosFile({ db, paths }, emulator, f))
    return out
  })
  handle('bios:remove', (slotId) => removeBios({ db, paths }, slotId))
  handle('bios:auto', (emulator) => autoInstallFirmware({ db, paths }, emulator, (p) => broadcast('emulators:progress', p)))
  // Raccourci clavier global pendant une partie (l'émulateur a le focus) : Ctrl+Alt+Q ferme le jeu proprement.
  const QUIT_KEY = 'CommandOrControl+Alt+Q'
  handle('game:play', (entryId) => launchGame(db, entryId, (s) => {
    broadcast('game:session', s)
    if (s.running) { if (!globalShortcut.isRegistered(QUIT_KEY)) globalShortcut.register(QUIT_KEY, stopAllGames) }
    else if (runningCount() === 0) globalShortcut.unregister(QUIT_KEY)
  }, join(paths.cache, 'tools'), paths.saves))
  handle('game:stop', (entryId) => stopGame(entryId))
  handle('game:running', () => listLibrary(db).map((e) => e.id).filter(isRunning))
  handle('providers:status', () => providerStatus(db, PROVIDERS, loadSettings(db)))

  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('win:fullscreen', (e, on: boolean) => BrowserWindow.fromWebContents(e.sender)?.setFullScreen(!!on))
}
