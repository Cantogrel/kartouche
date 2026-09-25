import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { cueFiles } from './importer'
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

const NO_FILE = 'nofile:'

/** Ajoute un jeu du catalogue sans fichier (la ROM s'y rattachera à l'import) ; renvoie l'entrée existante s'il y en a déjà une. */
export function addCatalogGame(db: DatabaseSync, gameId: number): LibraryEntry | null {
  const existing = db.prepare('SELECT * FROM library WHERE game_id = ?').get(gameId) as Row | undefined
  if (existing) return toEntry(existing)
  const g = db.prepare('SELECT console, name, title FROM catalog_games WHERE id = ?').get(gameId) as { console: string; name: string | null; title: string } | undefined
  if (!g) return null
  const id = Number(db.prepare('INSERT INTO library (game_id, console, title, path, size, match, missing, added_at) VALUES (?, ?, ?, ?, 0, \'none\', 1, ?)')
    .run(gameId, g.console, g.name ?? g.title, `${NO_FILE}${gameId}`, Date.now()).lastInsertRowid)
  return toEntry(db.prepare('SELECT * FROM library WHERE id = ?').get(id) as unknown as Row)
}

/** Dossier de sauvegardes d'un jeu : <saves>/<console>/<titre> (les émulateurs y seront configurés en Phase 5). */
export const saveDir = (savesRoot: string, e: { console: string; title: string }): string => join(savesRoot, e.console, e.title.replace(/[<>:"/\\|?*]/g, '_'))

export type RemoveAction = 'file' | 'entry' | 'save' | 'all'

async function deleteRomFiles(path: string): Promise<void> {
  if (path.startsWith(NO_FILE)) return
  // Feuille .cue : ses pistes partent avec elle.
  const tracks = extname(path).toLowerCase() === '.cue' ? await cueFiles(path).catch(() => []) : []
  for (const f of [path, ...tracks]) await rm(f, { force: true })
}

/**
 * Suppression, au choix : `file` (ROM supprimée, le jeu reste sans fichier), `entry` (retiré de la bibliothèque, ROM conservée),
 * `save` (sauvegardes seulement) ou `all` (ROM, sauvegardes et entrée).
 */
export async function removeEntry(db: DatabaseSync, id: number, action: RemoveAction, savesRoot: string): Promise<void> {
  const r = db.prepare('SELECT console, title, path FROM library WHERE id = ?').get(id) as { console: string; title: string; path: string } | undefined
  if (!r) return
  if (action === 'file' || action === 'all') await deleteRomFiles(r.path)
  if (action === 'save' || action === 'all') await rm(saveDir(savesRoot, r), { recursive: true, force: true })
  if (action === 'entry' || action === 'all') db.prepare('DELETE FROM library WHERE id = ?').run(id)
  else if (action === 'file') db.prepare('UPDATE library SET missing = 1 WHERE id = ?').run(id)
}

/** Chemin du fichier pour l'afficher dans l'Explorateur ; null si le jeu n'a pas de fichier. */
export function entryPath(db: DatabaseSync, id: number): string | null {
  const r = db.prepare('SELECT path FROM library WHERE id = ?').get(id) as { path: string } | undefined
  return r && !r.path.startsWith(NO_FILE) && existsSync(r.path) ? r.path : null
}
