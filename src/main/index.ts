import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db/migrations'
import { buildPaths, ensureDirs, resolveDataDir } from './paths'
import { registerIpc } from './ipc'

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
  const paths = buildPaths(resolveDataDir())
  ensureDirs(paths)
  const db = new DatabaseSync(join(paths.dataDir, 'romvault.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
  migrate(db)
  const { v } = db.prepare('select sqlite_version() as v').get() as { v: string }
  registerIpc({ db, paths, sqliteVersion: v })
  createWindow()
})
app.on('window-all-closed', () => app.quit())
