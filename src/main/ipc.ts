import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { IpcChannel, IpcChannels, AppPaths } from '@shared/ipc'
import { loadSettings, saveSettings } from './db/settingsStore'
import { setDataDir } from './paths'

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

  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
}
