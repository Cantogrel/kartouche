import { app, BrowserWindow, protocol } from 'electron'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db/migrations'
import { buildPaths, ensureDirs, resolveDataDir } from './paths'
import { registerIpc } from './ipc'
import { getImage } from './catalog/images'
import { getGame, rebuildDerived } from './catalog/catalogStore'
import { loadSettings } from './db/settingsStore'

// Images du catalogue servies depuis le cache disque : rvimg://card/<id du jeu> (vignette) et rvimg://hero/<id du jeu> (bannière)
protocol.registerSchemesAsPrivileged([{ scheme: 'rvimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

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
  // Colonnes dérivées (titre lisible, regroupement Europe d'abord) : recalculées quand la règle change.
  const DERIVED = '2'
  const cur = db.prepare("SELECT value FROM settings WHERE key = '_derived'").get() as { value: string } | undefined
  if (cur?.value !== DERIVED) {
    rebuildDerived(db)
    db.prepare("INSERT INTO settings (key, value) VALUES ('_derived', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(DERIVED)
  }
  protocol.handle('rvimg', async (req) => {
    const u = new URL(req.url)
    const game = getGame(db, Number(u.pathname.split('/').filter(Boolean)[0]))
    const kind = u.hostname === 'hero' ? 'hero' : 'card'
    const img = game ? await getImage(db, paths.cache, game, kind, loadSettings(db)) : null
    return img ? new Response(new Uint8Array(img.data), { headers: { 'content-type': img.type, 'cache-control': 'max-age=86400' } }) : new Response(null, { status: 404 })
  })
  registerIpc({ db, paths, sqliteVersion: v })
  createWindow()
})
app.on('window-all-closed', () => app.quit())
