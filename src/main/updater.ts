import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { DatabaseSync } from 'node:sqlite'
import type { UpdateChangelog, UpdateState } from '@shared/ipc'

let state: UpdateState = { status: 'idle', version: null, percent: 0, error: null }

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', state)
}

export const updateState = (): UpdateState => state

/** `releaseNotes` d'electron-updater : texte simple, ou une entrée par version sautée (mise à jour tardive) qu'on concatène. */
function notesText(notes: string | { version: string; note: string | null }[] | null | undefined): string {
  if (!notes) return ''
  return typeof notes === 'string' ? notes : notes.map((n) => n.note ?? '').filter(Boolean).join('\n\n')
}

function put(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}
function getRaw(db: DatabaseSync, key: string): unknown {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return undefined
  try { return JSON.parse(row.value) } catch { return undefined }
}

/** Dernier changelog connu (celui de la mise à jour la plus récemment téléchargée), quelle que soit la version en cours. */
export function lastChangelog(db: DatabaseSync): UpdateChangelog {
  const c = getRaw(db, 'changelog:data') as UpdateChangelog | undefined
  return c ?? null
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

/** Les mises à jour n'existent que dans l'app installée : en développement, tout est inerte. */
export function initUpdater(db: DatabaseSync): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
  autoUpdater.on('update-available', (i) => set({ status: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => { put(db, 'changelog:data', { version: i.version, notes: notesText(i.releaseNotes) }); set({ status: 'ready', version: i.version, percent: 100 }) })
  autoUpdater.on('error', (e) => set({ status: 'error', error: String(e?.message ?? e).split('\n')[0] }))
  setTimeout(() => void checkForUpdate(), 10_000)
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
