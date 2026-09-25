import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { LibraryEntry, MatchKind } from '@shared/library'

interface Row {
  id: number; game_id: number | null; console: string; title: string; path: string; size: number; match: string
  missing: number; added_at: number; play_minutes: number; last_played: number | null
}

const toEntry = (r: Row): LibraryEntry => ({
  id: r.id, gameId: r.game_id, console: r.console, title: r.title, path: r.path, size: r.size, match: r.match as MatchKind,
  missing: r.missing === 1, addedAt: r.added_at, playMinutes: r.play_minutes, lastPlayed: r.last_played
})

/** Vérifie sur disque la présence de chaque fichier de la bibliothèque et met à jour l'indicateur « manquant ». */
export function refreshMissing(db: DatabaseSync): number {
  const rows = db.prepare('SELECT id, path, missing FROM library').all() as { id: number; path: string; missing: number }[]
  const upd = db.prepare('UPDATE library SET missing = ? WHERE id = ?')
  let n = 0
  for (const r of rows) {
    const m = existsSync(r.path) ? 0 : 1
    if (m !== r.missing) upd.run(m, r.id)
    n += m
  }
  return n
}

export function listLibrary(db: DatabaseSync): LibraryEntry[] {
  refreshMissing(db)
  return (db.prepare('SELECT * FROM library ORDER BY title COLLATE NOCASE').all() as unknown as Row[]).map(toEntry)
}

/** Retire un jeu de la bibliothèque ; `deleteFile` supprime aussi la ROM sur disque. */
export async function removeEntry(db: DatabaseSync, id: number, deleteFile: boolean): Promise<void> {
  const r = db.prepare('SELECT path FROM library WHERE id = ?').get(id) as { path: string } | undefined
  if (!r) return
  db.prepare('DELETE FROM library WHERE id = ?').run(id)
  if (deleteFile) await rm(r.path, { force: true })
}
