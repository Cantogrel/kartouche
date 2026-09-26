import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/ipc'

let state: UpdateState = { status: 'idle', version: null, percent: 0, error: null }

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', state)
}

export const updateState = (): UpdateState => state

/** Les mises à jour n'existent que dans l'app installée : en développement, tout est inerte. */
export function initUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }))
  autoUpdater.on('update-available', (i) => set({ status: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version, percent: 100 }))
  autoUpdater.on('error', (e) => set({ status: 'error', error: String(e?.message ?? e).split('\n')[0] }))
  setTimeout(() => void checkForUpdate(), 10_000)
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
