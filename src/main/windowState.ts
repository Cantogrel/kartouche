import type { DatabaseSync } from 'node:sqlite'

/** Position/taille de la fenêtre principale hors plein écran, et si elle était maximisée à la fermeture. */
export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

const KEY = '_windowState'

export function loadWindowState(db: DatabaseSync): WindowState | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const s = JSON.parse(row.value) as Partial<WindowState>
    if (typeof s.width !== 'number' || typeof s.height !== 'number') return null
    return { width: s.width, height: s.height, x: typeof s.x === 'number' ? s.x : undefined, y: typeof s.y === 'number' ? s.y : undefined, maximized: !!s.maximized }
  } catch { return null }
}

export function saveWindowState(db: DatabaseSync, state: WindowState): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(state))
}
