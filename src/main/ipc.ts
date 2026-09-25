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
import { syncPopularity } from './catalog/popularity'
import { localizeDetails } from './catalog/l10n'
import { resolveLanguage } from '@shared/settings'

/** Ordre de la cascade de fiches enrichies. */
const PROVIDERS: MetadataProvider[] = [igdb, tgdb]
let syncing = false
/** À incrémenter quand la passe IGDB (popularité, genre, développeur, année) change : elle est alors relancée une fois. */
const ENRICH_VERSION = '2'

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
  handle('catalog:details', async (req) => {
    const game = getGame(db, req.id)
    if (!game) return null
    const s = loadSettings(db)
    const base = await getDetails(db, game, PROVIDERS, s, { refresh: req.refresh })
    // Description dans la langue de l'interface (Wikipédia, sinon traduction automatique).
    const d = await localizeDetails(db, game, base ?? { provider: 'wikipedia' }, resolveLanguage(s.language, app.getLocale()))
    return d.summary || base ? d : null
  })
  handle('catalog:sync', async (ids) => {
    if (syncing) return { synced: 0, failed: [] }
    syncing = true
    try {
      return await syncCatalog(db, ids, (p) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('catalog:progress', p)), undefined, loadSettings(db))
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
  handle('providers:status', () => providerStatus(db, PROVIDERS, loadSettings(db)))

  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}
