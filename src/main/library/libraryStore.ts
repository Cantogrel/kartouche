import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { cueFiles } from './importer'
import { deleteGameSaves } from '../saves/saves'
import type { LibraryEntry, MatchKind, SbiImportResult } from '@shared/library'

interface Row {
  id: number; game_id: number | null; console: string; title: string; path: string; size: number; match: string
  missing: number; added_at: number; play_minutes: number; last_played: number | null; favorite: number; pinned: number
}

const toEntry = (r: Row, collections: number[] = []): LibraryEntry => ({
  id: r.id, gameId: r.game_id, console: r.console, title: r.title, path: r.path, size: r.size, match: r.match as MatchKind,
  missing: r.missing === 1, addedAt: r.added_at, playMinutes: r.play_minutes, lastPlayed: r.last_played,
  favorite: r.favorite === 1, pinned: r.pinned === 1, collections
})

/** Collections de chaque jeu (id de bibliothèque → ids de collection), en une seule requête. */
function membership(db: DatabaseSync): Map<number, number[]> {
  const m = new Map<number, number[]>()
  for (const r of db.prepare('SELECT library_id, collection_id FROM collection_items ORDER BY collection_id').all() as { library_id: number; collection_id: number }[]) {
    const l = m.get(r.library_id)
    if (l) l.push(r.collection_id); else m.set(r.library_id, [r.collection_id])
  }
  return m
}

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
  const mem = membership(db)
  return (db.prepare('SELECT * FROM library ORDER BY title COLLATE NOCASE').all() as unknown as Row[]).map((r) => toEntry(r, mem.get(r.id)))
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
  if (action === 'save' || action === 'all') {
    // Avant la ROM : melonDS range ses sauvegardes à côté d'elle. Copies de sécurité (backups/) conservées volontairement.
    await deleteGameSaves(db, savesRoot, { id, console: r.console, path: r.path }).catch(() => {})
    await rm(saveDir(savesRoot, r), { recursive: true, force: true })
  }
  if (action === 'file' || action === 'all') await deleteRomFiles(r.path)
  if (action === 'entry' || action === 'all') db.prepare('DELETE FROM library WHERE id = ?').run(id)
  else if (action === 'file') db.prepare('UPDATE library SET missing = 1 WHERE id = ?').run(id)
}

/** Chemin du fichier pour l'afficher dans l'Explorateur ; null si le jeu n'a pas de fichier. */
export function entryPath(db: DatabaseSync, id: number): string | null {
  const r = db.prepare('SELECT path FROM library WHERE id = ?').get(id) as { path: string } | undefined
  return r && !r.path.startsWith(NO_FILE) && existsSync(r.path) ? r.path : null
}

/** Emplacement attendu du fichier .sbi d'une entrée (même nom que le fichier lancé, extension .sbi) ; null si la console n'en a pas besoin. */
export function sbiPathFor(entry: { console: string; path: string }): string | null {
  if (entry.console !== 'ps1') return null
  return join(dirname(entry.path), basename(entry.path, extname(entry.path)) + '.sbi')
}

/** Copie un fichier .sbi fourni par l'utilisateur à côté de la ROM, sous le nom que l'émulateur attend (protection libcrypt). */
export async function importSbi(db: DatabaseSync, entryId: number, sourcePath: string): Promise<SbiImportResult> {
  const row = db.prepare('SELECT console, path FROM library WHERE id = ?').get(entryId) as { console: string; path: string } | undefined
  if (!row) return { ok: false, error: 'notFound' }
  const dest = sbiPathFor(row)
  if (!dest) return { ok: false, error: 'notPs1' }
  if (extname(sourcePath).toLowerCase() !== '.sbi') return { ok: false, error: 'badFile' }
  try {
    await copyFile(sourcePath, dest)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}
