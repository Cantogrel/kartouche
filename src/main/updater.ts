import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { DatabaseSync } from 'node:sqlite'
import type { UpdateChangelog, UpdateState } from '@shared/ipc'
import changelogMd from '../../CHANGELOG.md?raw'

let state: UpdateState = { status: 'idle', version: null, percent: 0, error: null }

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', state)
}

export const updateState = (): UpdateState => state

/**
 * electron-updater lit les notes de version depuis le flux Atom des releases GitHub, qui les fournit en HTML déjà
 * rendu (`<ul><li>…`) plutôt qu'en markdown brut : on les reconvertit en texte simple pour rester affichable tel
 * quel, comme le texte du CHANGELOG.md local (voir `localNotes`).
 */
function htmlToText(html: string): string {
  return html
    .replace(/<li>/gi, '- ')
    .replace(/<\/(li|p|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
}

/** `releaseNotes` d'electron-updater : texte simple ou HTML, ou une entrée par version sautée (mise à jour tardive) qu'on concatène. */
function notesText(notes: string | { version: string; note: string | null }[] | null | undefined): string {
  if (!notes) return ''
  const text = typeof notes === 'string' ? notes : notes.map((n) => n.note ?? '').filter(Boolean).join('\n\n')
  return /<[a-z][\s\S]*>/i.test(text) ? htmlToText(text) : text
}

function put(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}
function getRaw(db: DatabaseSync, key: string): unknown {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return undefined
  try { return JSON.parse(row.value) } catch { return undefined }
}

/** Notes de `## <version>` dans CHANGELOG.md ; null si la version n'y a pas de section (build de dev entre deux versions). */
function localNotes(version: string): string | null {
  const m = new RegExp(`^##\\s*v?${version.replace(/\./g, '\\.')}\\b.*$`, 'm').exec(changelogMd)
  if (!m) return null
  const rest = changelogMd.slice(m.index + m[0].length)
  const next = rest.search(/^##\s/m)
  return rest.slice(0, next === -1 ? undefined : next).trim()
}

/**
 * Renseigne le changelog depuis le fichier local dès qu'on tourne sur une version pas encore vue : contrairement à
 * `update-downloaded` (déclenché seulement par la mise à jour automatique in-app via GitHub Releases), ça marche
 * aussi quand l'installateur a été lancé à la main (build local testé avant publication de la release).
 */
export function ensureLocalChangelog(db: DatabaseSync): void {
  const version = app.getVersion()
  if (lastChangelog(db)?.version === version) return
  const notes = localNotes(version)
  if (notes !== null) put(db, 'changelog:data', { version, notes })
}

/** Dernier changelog connu (celui de la mise à jour la plus récemment téléchargée), quelle que soit la version en cours. */
export function lastChangelog(db: DatabaseSync): UpdateChangelog {
  const c = getRaw(db, 'changelog:data') as UpdateChangelog | undefined
  if (!c) return null
  // Auto-corrige les notes stockées avant le passage de notesText() par htmlToText() (ex. mise à jour vers la 0.1.7).
  return /<[a-z][\s\S]*>/i.test(c.notes) ? { ...c, notes: htmlToText(c.notes) } : c
}

/**
 * Changelog à proposer une seule fois après une mise à jour installée : renvoie les notes seulement si elles
 * correspondent à la version tournant actuellement (donc qu'on vient de démarrer sur la version fraîchement
 * installée) et qu'elles n'ont pas déjà été montrées ; marque aussitôt qu'elles l'ont été.
 */
export function pendingChangelog(db: DatabaseSync): UpdateChangelog {
  const c = lastChangelog(db)
  if (!c || c.version !== app.getVersion()) return null
  if (getRaw(db, 'changelog:shownFor') === c.version) return null
  put(db, 'changelog:shownFor', c.version)
  return c
}

const RECHECK_MS = 6 * 3600 * 1000
const RETRY_MS = 10_000

/** Les mises à jour n'existent que dans l'app installée : en développement, tout est inerte. */
export function initUpdater(db: DatabaseSync, win: BrowserWindow): void {
  ensureLocalChangelog(db)
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
  autoUpdater.on('update-available', (i) => set({ status: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => { put(db, 'changelog:data', { version: i.version, notes: notesText(i.releaseNotes) }); set({ status: 'ready', version: i.version, percent: 100 }) })
  autoUpdater.on('error', (e) => set({ status: 'error', error: String(e?.message ?? e).split('\n')[0] }))
  // Première vérification quand la fenêtre est affichée (le démarrage n'est plus concurrencé par le réseau) ; si elle
  // échoue (réseau pas encore prêt, GitHub indisponible...), une seule nouvelle tentative 10 s plus tard.
  const startupCheck = async (retry: boolean): Promise<void> => {
    await checkForUpdate()
    if (retry && state.status === 'error') setTimeout(() => void startupCheck(false), RETRY_MS)
  }
  win.once('ready-to-show', () => void startupCheck(true))
  // Une seule vérification au lancement ne suffit pas pour une app laissée ouverte plusieurs jours : sans ça, une
  // sortie de release entre deux redémarrages ne serait jamais détectée tant que rien ne redéclenche la recherche.
  setInterval(() => { if (state.status === 'idle' || state.status === 'none' || state.status === 'error') void checkForUpdate() }, RECHECK_MS)
}

export async function checkForUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) { set({ status: 'unavailable' }); return state }
  try { await autoUpdater.checkForUpdates() } catch { /* remonté par l'événement 'error' */ }
  return state
}

export async function downloadUpdate(): Promise<void> {
  if (state.status !== 'available') return
  try { await autoUpdater.downloadUpdate() } catch { /* idem */ }
}

export function installUpdate(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall()
}
