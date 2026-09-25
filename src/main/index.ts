import { app, BrowserWindow, protocol } from 'electron'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db/migrations'
import { buildPaths, ensureDirs, resolveDataDir } from './paths'
import { registerIpc } from './ipc'
import { getHero, getThumbnail } from './catalog/thumbs'

// Images du catalogue servies depuis le cache disque : rvimg://cover/<console>/<titre encodé> et rvimg://hero/<id du jeu>
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
  protocol.handle('rvimg', async (req) => {
    const u = new URL(req.url)
    const parts = u.pathname.split('/').filter(Boolean)
    const png = (b: Buffer): Response => new Response(new Uint8Array(b), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } })
    if (u.hostname === 'hero') {
      const h = await getHero(db, paths.cache, Number(parts[0]))
      return h ? new Response(new Uint8Array(h.data), { headers: { 'content-type': h.type, 'cache-control': 'max-age=86400' } }) : new Response(null, { status: 404 })
    }
    const buf = parts[0] ? await getThumbnail(paths.cache, parts[0], decodeURIComponent(parts.slice(1).join('/'))) : null
    return buf ? png(buf) : new Response(null, { status: 404 })
  })
  registerIpc({ db, paths, sqliteVersion: v })
  createWindow()
})
app.on('window-all-closed', () => app.quit())
