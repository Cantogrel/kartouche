import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@shared/settings'

export function loadSettings(db: DatabaseSync): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const stored: Record<string, unknown> = {}
  for (const r of rows) {
    try { stored[r.key] = JSON.parse(r.value) } catch { /* valeur corrompue : on retombe sur le défaut */ }
  }
  return mergeSettings(DEFAULT_SETTINGS, stored)
}

export function saveSettings(db: DatabaseSync, patch: Partial<Settings>): Settings {
  const next = mergeSettings(loadSettings(db), patch)
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const [k, v] of Object.entries(next)) up.run(k, JSON.stringify(v))
  return next
}
