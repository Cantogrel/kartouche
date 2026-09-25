import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400, height: 860, minWidth: 1000, minHeight: 640,
    backgroundColor: '#0e0e0e', frame: false, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true }
  })
  win.once('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: process.env['ROMVAULT_HASH'] })
  return win
}

app.whenReady().then(() => {
  ipcMain.handle('ping', () => {
    const db = new DatabaseSync(':memory:')
    const row = db.prepare('select sqlite_version() as v').get() as { v: string }
    db.close()
    return { ok: true, sqlite: row.v, locale: app.getLocale() }
  })
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  createWindow()
})
app.on('window-all-closed', () => app.quit())
