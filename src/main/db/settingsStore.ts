import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from '@shared/settings'
import { PROXY_KEY } from '@shared/proxy'

/** Réglages saisis par l'utilisateur, tels que stockés : c'est ce que voit l'interface. */
export function loadUserSettings(db: DatabaseSync): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const stored: Record<string, unknown> = {}
  for (const r of rows) {
    try { stored[r.key] = JSON.parse(r.value) } catch { /* valeur corrompue : on retombe sur le défaut */ }
  }
  return mergeSettings(DEFAULT_SETTINGS, stored)
}

/** Réglages effectifs : une clé de catalogue laissée vide passe par le proxy Kartouche (RetroAchievements reste à l'utilisateur). */
export function loadSettings(db: DatabaseSync): Settings {
  const s = loadUserSettings(db)
  if (!s.igdbClientId || !s.igdbClientSecret) { s.igdbClientId = PROXY_KEY; s.igdbClientSecret = PROXY_KEY }
  if (!s.tgdbApiKey) s.tgdbApiKey = PROXY_KEY
  if (!s.sgdbApiKey) s.sgdbApiKey = PROXY_KEY
  return s
}

export function saveSettings(db: DatabaseSync, patch: Partial<Settings>): Settings {
  const next = mergeSettings(loadUserSettings(db), patch)
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const [k, v] of Object.entries(next)) up.run(k, JSON.stringify(v))
  return next
}
