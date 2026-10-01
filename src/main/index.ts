import { app, BrowserWindow, protocol, screen } from 'electron'
import { join } from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db/migrations'
import { buildPaths, ensureDirs, resolveDataDir } from './paths'
import { autoSyncCatalogOnUpdate, registerIpc } from './ipc'
import { getImage, type ImageKind } from './catalog/images'
import { getGame, rebuildDerived } from './catalog/catalogStore'
import { loadSettings } from './db/settingsStore'
import { initUpdater } from './updater'
import { loadWindowState, saveWindowState, type WindowState } from './windowState'

// Images du catalogue servies depuis le cache disque : rvimg://card|tile|hero|icon/<id du jeu> (vignette catalogue, tuile bibliothèque, bannière, icône)
protocol.registerSchemesAsPrivileged([{ scheme: 'rvimg', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

/** Faux si les bornes sauvegardées tombent hors de tout écran actuellement branché (moniteur externe débranché…). */
function onScreen(b: { x?: number; y?: number; width: number; height: number }): boolean {
  if (b.x === undefined || b.y === undefined) return false
  return screen.getAllDisplays().some((d) => b.x! < d.bounds.x + d.bounds.width && b.x! + b.width > d.bounds.x && b.y! < d.bounds.y + d.bounds.height && b.y! + b.height > d.bounds.y)
}

function createWindow(db: DatabaseSync): BrowserWindow {
  const stored = loadWindowState(db)
  const saved = stored && onScreen(stored) ? stored : stored ? { ...stored, x: undefined, y: undefined } : null
  const win = new BrowserWindow({
    width: saved?.width ?? 1400, height: saved?.height ?? 860, x: saved?.x, y: saved?.y, minWidth: 1000, minHeight: 640,
    backgroundColor: '#0e0e0e', frame: false, show: false, icon: join(app.getAppPath(), 'build/icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true }
  })
  win.once('ready-to-show', () => { if (saved?.maximized) win.maximize(); win.show() })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: process.env['ROMVAULT_HASH'] ?? (process.argv.includes('--bigpicture') ? 'bigpicture' : undefined) })

  // Bornes hors plein écran seulement (sinon on perdrait la taille normale à laquelle revenir) ; écrites au changement, avec un délai pour ne pas spammer pendant un redimensionnement à la souris.
  let pending: WindowState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const capture = (): void => {
    if (win.isDestroyed() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    pending = maximized ? { ...(pending ?? { width: 1400, height: 860, maximized: true }), maximized } : { ...win.getBounds(), maximized }
    if (timer) return
    timer = setTimeout(() => { timer = null; if (pending) saveWindowState(db, pending) }, 500)
  }
  win.on('resize', capture)
  win.on('move', capture)
  win.on('maximize', capture)
  win.on('unmaximize', capture)
  win.on('close', () => { if (timer) clearTimeout(timer); if (!win.isFullScreen()) saveWindowState(db, { ...(pending ?? win.getBounds()), maximized: win.isMaximized() }) })
  return win
}

// Une seule instance : cliquer plusieurs fois sur l'exécutable (ou un raccourci) ne doit pas ouvrir plusieurs fenêtres
// sur la même base SQLite (écritures concurrentes) — l'instance déjà lancée reprend juste le premier plan. Doit être
// tranché avant `whenReady` : l'instance perdante ne doit ni créer de fenêtre ni toucher la base.
let mainWindow: BrowserWindow | null = null
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    const paths = buildPaths(resolveDataDir())
    ensureDirs(paths)
    const db = new DatabaseSync(join(paths.dataDir, 'romvault.db'))
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
    migrate(db)
    const { v } = db.prepare('select sqlite_version() as v').get() as { v: string }
    // Colonnes dérivées (titre lisible, regroupement Europe d'abord) : recalculées quand la règle change.
    const DERIVED = '3'
    const cur = db.prepare("SELECT value FROM settings WHERE key = '_derived'").get() as { value: string } | undefined
    if (cur?.value !== DERIVED) {
      rebuildDerived(db)
      db.prepare("INSERT INTO settings (key, value) VALUES ('_derived', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(DERIVED)
    }
    // Les fiches mises en cache avant la correction du choix de jeu IGDB (un mod pouvait remplacer le jeu) sont refaites une fois.
    // v3 : les échecs de recherche d'icône SteamGridDB mémorisés avant l'assouplissement de `sgdbId` (préfixe accepté,
    // pas seulement l'égalité stricte) sont retentés une fois — une bonne partie n'était refusée qu'à cause d'un
    // sous-titre ("Special Pikachu Edition"...) absent du nom court de SteamGridDB. Les identifiants déjà trouvés
    // (json non nul) ne sont pas relancés : ils restent valables.
    if ((db.prepare("SELECT value FROM settings WHERE key = '_meta'").get() as { value: string } | undefined)?.value !== '3') {
      db.exec("DELETE FROM game_meta WHERE provider IN ('igdb') OR provider LIKE 'l10n-%' OR (provider = 'sgdb-id' AND json_extract(json, '$.id') IS NULL)")
      db.prepare("INSERT INTO settings (key, value) VALUES ('_meta', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
      // L'icône est le seul format à ne tenter QUE SteamGridDB (pas de repli Libretro/IGDB) : son marqueur `.miss`
      // (7 jours) doit sauter tout de suite, sinon le geste ci-dessus ne se voit qu'après son expiration naturelle.
      const iconDir = join(paths.cache, 'images', 'icon')
      readdir(iconDir).then((files) => Promise.all(files.filter((f) => f.endsWith('.miss')).map((f) => rm(join(iconDir, f))))).catch(() => { /* dossier pas encore créé : rien à nettoyer */ })
    }
    protocol.handle('rvimg', async (req) => {
      const u = new URL(req.url)
      const game = getGame(db, Number(u.pathname.split('/').filter(Boolean)[0]))
      const kind: ImageKind = u.hostname === 'hero' || u.hostname === 'icon' || u.hostname === 'tile' ? u.hostname : 'card'
      try {
        const img = game ? await getImage(db, paths.cache, game, kind, loadSettings(db), req.signal) : null
        return img ? new Response(new Uint8Array(img.data), { headers: { 'content-type': img.type, 'cache-control': 'max-age=86400' } }) : new Response(null, { status: 404 })
      } catch (e) {
        // Tuile refermée avant la fin de la résolution (filtres changés vite) : la requête est déjà abandonnée côté rendu.
        if (e instanceof DOMException && e.name === 'AbortError') return new Response(null, { status: 499 })
        throw e
      }
    })
    registerIpc({ db, paths, sqliteVersion: v })
    mainWindow = createWindow(db)
    mainWindow.on('closed', () => { mainWindow = null })
    initUpdater(db)
    void autoSyncCatalogOnUpdate(db)
  })
  app.on('window-all-closed', () => app.quit())
}
