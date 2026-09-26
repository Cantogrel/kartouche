import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { EMULATORS, type EmulatorState } from '@shared/emulators'

interface Row { id: string; version: string | null; dir: string; exe: string; custom: number; installed_at: number }

export function getRow(db: DatabaseSync, id: string): Row | undefined {
  return db.prepare('SELECT * FROM emulators WHERE id = ?').get(id) as Row | undefined
}

export function saveEmulator(db: DatabaseSync, e: { id: string; version: string | null; dir: string; exe: string; custom: boolean }): void {
  db.prepare(`INSERT INTO emulators (id, version, dir, exe, custom, installed_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, dir = excluded.dir, exe = excluded.exe, custom = excluded.custom, installed_at = excluded.installed_at`)
    .run(e.id, e.version, e.dir, e.exe, e.custom ? 1 : 0, Date.now())
}

export function deleteEmulator(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM emulators WHERE id = ?').run(id)
}

/** État de tous les émulateurs connus (installés ou non), avec vérification de la présence de l'exécutable. */
export function listEmulators(db: DatabaseSync): EmulatorState[] {
  return EMULATORS.map((def) => {
    const r = getRow(db, def.id)
    if (!r) return { id: def.id, installed: false, version: null, dir: null, exe: null, custom: false, installedAt: null, missing: false }
    return { id: def.id, installed: true, version: r.version, dir: r.dir, exe: r.exe, custom: r.custom === 1, installedAt: r.installed_at, missing: !existsSync(r.exe) }
  })
}
