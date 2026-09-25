import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { IpcChannel, IpcChannels, AppPaths } from '@shared/ipc'
import { loadSettings, saveSettings } from './db/settingsStore'
import { setDataDir } from './paths'
import { catalogCount, getGame, queryCatalog } from './catalog/catalogStore'
import { syncCatalog } from './catalog/sync'
import { getDetails, providerStatus, type MetadataProvider } from './catalog/providers'
import { igdb } from './catalog/igdb'
import { tgdb } from './catalog/tgdb'
import { sgdb } from './catalog/sgdb'
import { syncPopularity } from './catalog/popularity'

/** Ordre de la cascade de fiches enrichies. */
const PROVIDERS: MetadataProvider[] = [igdb, tgdb, sgdb]
let syncing = false

type Handler<C extends IpcChannel> = (req: IpcChannels[C]['req']) => IpcChannels[C]['res'] | Promise<IpcChannels[C]['res']>
function handle<C extends IpcChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, (_e, req) => fn(req))
}

export function registerIpc(ctx: { db: DatabaseSync; paths: AppPaths; sqliteVersion: string }): void {
  const { db, paths } = ctx
  handle('app:info', () => ({ version: app.getVersion(), osLocale: app.getLocale(), sqlite: ctx.sqliteVersion, paths }))
  handle('settings:get', () => loadSettings(db))
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

  handle('catalog:search', (q) => queryCatalog(db, q ?? {}))
  handle('catalog:get', (id) => getGame(db, id))
  handle('catalog:details', (req) => {
    const game = getGame(db, req.id)
    return game ? getDetails(db, game, PROVIDERS, loadSettings(db), { refresh: req.refresh }) : null
  })
  handle('catalog:sync', async (ids) => {
    if (syncing) return { synced: 0, failed: [] }
    syncing = true
    try {
      return await syncCatalog(db, ids, (p) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('catalog:progress', p)))
    } finally { syncing = false }
  })
  handle('catalog:popularity', async () => {
    const s = loadSettings(db)
    if (!igdb.isConfigured(s) || syncing) return 0
    syncing = true
    try {
      return await syncPopularity(db, s, (done, total) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('catalog:progress', { console: 'popularity', done, total })))
    } catch { return 0 } finally { syncing = false }
  })
  handle('catalog:status', () => {
    const r = db.prepare('SELECT MAX(synced_at) AS at FROM catalog_sync').get() as { at: number | null }
    const rated = db.prepare('SELECT COUNT(*) AS n FROM catalog_games WHERE popularity IS NOT NULL').get() as { n: number }
    return { total: catalogCount(db), syncedAt: r.at, syncing, rated: rated.n }
  })
  handle('providers:status', () => providerStatus(db, PROVIDERS, loadSettings(db)))

  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}
