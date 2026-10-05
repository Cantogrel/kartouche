import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { loadSettings, saveSettings } from '../db/settingsStore'
import { CUSTOM_ID_PREFIX, validateCustomEmulator, type CustomEmulator, type CustomEmulatorState, type SaveEmulatorResult } from '@shared/customEmulators'

interface Row { id: string; name: string; exe: string; args: string; consoles: string; extensions: string }

const parse = (json: string): string[] => { try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] } }
const toEmulator = (r: Row): CustomEmulator => ({ id: r.id, name: r.name, exe: r.exe, args: r.args, consoles: parse(r.consoles), extensions: parse(r.extensions) })

export function listCustomEmulators(db: DatabaseSync): CustomEmulatorState[] {
  return (db.prepare('SELECT * FROM custom_emulators ORDER BY name COLLATE NOCASE').all() as unknown as Row[]).map((r) => ({ ...toEmulator(r), missing: !existsSync(r.exe) }))
}

export function getCustomEmulator(db: DatabaseSync, id: string): CustomEmulator | null {
  const r = db.prepare('SELECT * FROM custom_emulators WHERE id = ?').get(id) as Row | undefined
  return r ? toEmulator(r) : null
}

/**
 * Ajoute (sans `id`) ou modifie (avec `id`) un émulateur personnalisé. L'exécutable doit exister au moment de l'enregistrement ; ensuite, s'il disparaît,
 * l'émulateur reste listé comme « introuvable » plutôt que d'être supprimé en silence.
 */
export function saveCustomEmulator(db: DatabaseSync, input: unknown, id?: string): SaveEmulatorResult {
  const v = validateCustomEmulator(input)
  if (!v.ok) return v
  if (!existsSync(v.value.exe)) return { ok: false, error: 'exe' }
  const consoles = JSON.stringify(v.value.consoles)
  const extensions = JSON.stringify(v.value.extensions)
  if (id !== undefined) {
    const r = db.prepare('UPDATE custom_emulators SET name = ?, exe = ?, args = ?, consoles = ?, extensions = ? WHERE id = ?').run(v.value.name, v.value.exe, v.value.args, consoles, extensions, id)
    return Number(r.changes) > 0 ? { ok: true, id } : { ok: false, error: 'notFound' }
  }
  const next = ((db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 8) AS INTEGER)), 0) AS n FROM custom_emulators").get() as { n: number }).n) + 1
  const newId = `${CUSTOM_ID_PREFIX}${next}`
  db.prepare('INSERT INTO custom_emulators (id, name, exe, args, consoles, extensions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(newId, v.value.name, v.value.exe, v.value.args, consoles, extensions, Date.now())
  return { ok: true, id: newId }
}

/** Supprime un émulateur personnalisé ; les jeux qui le choisissaient retombent sur l'émulateur par défaut de leur console. */
export function deleteCustomEmulator(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE library SET emulator_id = NULL WHERE emulator_id = ?').run(id)
  db.prepare('DELETE FROM custom_emulators WHERE id = ?').run(id)
  // Les identifiants sont réutilisés (MAX + 1) : un défaut de console oublié ici serait hérité par le prochain émulateur ajouté.
  const defaults = loadSettings(db).emulatorDefaults
  const kept = Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== id))
  if (Object.keys(kept).length !== Object.keys(defaults).length) saveSettings(db, { emulatorDefaults: kept })
}

/** Émulateurs personnalisés qui savent lancer cette console, dans l'ordre alphabétique. */
export function customEmulatorsForConsole(db: DatabaseSync, consoleId: string): CustomEmulator[] {
  return listCustomEmulators(db).filter((e) => e.consoles.includes(consoleId))
}
