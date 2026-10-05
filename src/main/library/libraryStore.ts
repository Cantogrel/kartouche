import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { cueFiles } from './importer'
import { identify } from './identify'
import { deleteGameSaves } from '../saves/saves'
import { contentDir, parkContent } from './content/store'
import { uninstallContent } from '../emulators/content'
import type { LibraryContentItem, LibraryEntry, MatchKind, SbiImportResult } from '@shared/library'
import { OVERRIDE_FIELDS, type EntryOverrides } from '@shared/overrides'
import { loadOverrides } from './overrides'

interface Row {
  id: number; game_id: number | null; console: string; title: string; path: string; size: number; match: string
  missing: number; added_at: number; play_minutes: number; last_played: number | null; favorite: number; pinned: number
}

const toEntry = (r: Row, collections: number[] = [], hasSources = false, overrides: EntryOverrides = {}): LibraryEntry => ({
  id: r.id, gameId: r.game_id, console: r.console, title: r.title, shownTitle: overrides.title ?? r.title,
  overridden: OVERRIDE_FIELDS.filter((f) => overrides[f] !== undefined), path: r.path, size: r.size, match: r.match as MatchKind,
  missing: r.missing === 1, addedAt: r.added_at, playMinutes: r.play_minutes, lastPlayed: r.last_played,
  favorite: r.favorite === 1, pinned: r.pinned === 1, collections, hasSources
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

/** Jeux du catalogue (id) pour lesquels au moins une liste de sources propose un téléchargement. */
function gamesWithSources(db: DatabaseSync): Set<number> {
  return new Set((db.prepare('SELECT DISTINCT game_id FROM sources WHERE game_id IS NOT NULL').all() as { game_id: number }[]).map((r) => r.game_id))
}

export function listLibrary(db: DatabaseSync): LibraryEntry[] {
  refreshMissing(db)
  const mem = membership(db)
  const withSources = gamesWithSources(db)
  const overrides = loadOverrides(db)
  const entries = (db.prepare('SELECT * FROM library ORDER BY title COLLATE NOCASE').all() as unknown as Row[])
    .map((r) => toEntry(r, mem.get(r.id), r.game_id !== null && withSources.has(r.game_id), overrides.get(r.id)))
  // Liste triée par titre affiché : seulement quand un titre a été modifié (sinon l'ordre SQL d'origine est déjà le bon).
  if (entries.some((e) => e.shownTitle !== e.title)) entries.sort((a, b) => a.shownTitle.toLowerCase().localeCompare(b.shownTitle.toLowerCase()))
  return entries
}

const entryById = (db: DatabaseSync, id: number): LibraryEntry =>
  toEntry(db.prepare('SELECT * FROM library WHERE id = ?').get(id) as unknown as Row, undefined, undefined, loadOverrides(db, [id]).get(id))

/**
 * Retente l'identification des entrées sans fiche VALIDE : `game_id` NULL (jeu absent du catalogue au moment de
 * l'import, ex. filtre IGDB Switch alors trop strict) OU `game_id` orphelin (pointe vers une ligne de `catalog_games`
 * qui n'existe plus : `replaceConsole` réinsère ses lignes avec de nouveaux id à chaque resynchro — voir sa note).
 * N'accepte qu'un résultat sur la MÊME console (jamais de réassignation de console).
 */
export function relinkUnmatched(db: DatabaseSync): number {
  const rows = db.prepare(`SELECT id, console, title, crc, sha1 FROM library
    WHERE game_id IS NULL OR NOT EXISTS (SELECT 1 FROM catalog_games c WHERE c.id = library.game_id)`).all() as
    { id: number; console: string; title: string; crc: string | null; sha1: string | null }[]
  const upd = db.prepare('UPDATE library SET game_id = ?, title = ?, match = ? WHERE id = ?')
  let relinked = 0
  for (const r of rows) {
    const found = identify(db, { name: r.title, ext: '', crc: r.crc ?? undefined, sha1: r.sha1 ?? undefined })
    if (found.gameId !== null && found.console === r.console) { upd.run(found.gameId, found.title ?? r.title, found.match, r.id); relinked++ }
  }
  return relinked
}

const NO_FILE = 'nofile:'

/** Ajoute un jeu du catalogue sans fichier (la ROM s'y rattachera à l'import) ; renvoie l'entrée existante s'il y en a déjà une. */
export function addCatalogGame(db: DatabaseSync, gameId: number): LibraryEntry | null {
  const existing = db.prepare('SELECT * FROM library WHERE game_id = ?').get(gameId) as Row | undefined
  if (existing) return entryById(db, existing.id)
  const g = db.prepare('SELECT console, name, title FROM catalog_games WHERE id = ?').get(gameId) as { console: string; name: string | null; title: string } | undefined
  if (!g) return null
  const id = Number(db.prepare('INSERT INTO library (game_id, console, title, path, size, match, missing, added_at) VALUES (?, ?, ?, ?, 0, \'none\', 1, ?)')
    .run(gameId, g.console, g.name ?? g.title, `${NO_FILE}${gameId}`, Date.now()).lastInsertRowid)
  return entryById(db, id)
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

// Vita3K n'a pas de mode portable (voir emulators.ts) : ses données vivent dans le dossier utilisateur Windows, pas
// dans data/emulators/vita3k comme les autres émulateurs.
const vita3kUserDir = (): string => join(homedir(), 'AppData', 'Roaming', 'Vita3K', 'Vita3K')

/**
 * Suppression, au choix : `file` (ROM supprimée, le jeu reste sans fichier), `entry` (retiré de la bibliothèque, ROM conservée),
 * `save` (sauvegardes seulement) ou `all` (ROM, sauvegardes et entrée).
 */
export async function removeEntry(db: DatabaseSync, id: number, action: RemoveAction, savesRoot: string, romsDir?: string): Promise<void> {
  const r = db.prepare('SELECT console, title, path, title_id, vita_title_id FROM library WHERE id = ?').get(id) as
    { console: string; title: string; path: string; title_id: string | null; vita_title_id: string | null } | undefined
  if (!r) return
  if (action === 'save' || action === 'all') {
    // Avant la ROM : melonDS range ses sauvegardes à côté d'elle. Copies de sécurité (backups/) conservées volontairement.
    await deleteGameSaves(db, savesRoot, { id, console: r.console, path: r.path }).catch(() => {})
    await rm(saveDir(savesRoot, r), { recursive: true, force: true })
  }
  if (action === 'file' || action === 'all') {
    await deleteRomFiles(r.path)
    await uninstallAllContent(db, id, romsDir)
    // Vita3K installe sa propre copie du jeu (ux0/app/<Title ID>), indépendante du .vpk : sans ça, le jeu reste visible
    // dans SA bibliothèque même après suppression ici (constaté en vrai).
    if (r.vita_title_id) {
      const dir = vita3kUserDir()
      await rm(join(dir, 'ux0', 'app', r.vita_title_id), { recursive: true, force: true }).catch(() => undefined)
      await rm(join(dir, 'ux0', 'license', r.vita_title_id), { recursive: true, force: true }).catch(() => undefined)
    }
  }
  if (action === 'all') {
    // Ses mises à jour/DLC rangés par Kartouche (voir library/content/store.ts) : <roms>/<console>/.content/<identifiant du jeu>/. Les contenus laissés où ils
    // étaient (mode « ne pas copier ») ne sont jamais supprimés.
    if (r.title_id) {
      if (romsDir) await rm(contentDir(romsDir, r.console, r.title_id), { recursive: true, force: true }).catch(() => undefined)
      await rm(join(dirname(r.path), '.content', r.title_id), { recursive: true, force: true }).catch(() => undefined)
    }
    db.prepare('DELETE FROM library WHERE id = ?').run(id)
  } else if (action === 'entry') {
    // ROM conservée : ses mises à jour/DLC restent sur le disque et attendent le jeu, rattachés de nouveau s'il est réimporté.
    parkContent(db, id)
    db.prepare('DELETE FROM library WHERE id = ?').run(id)
  }
  // vita_title_id remis à zéro : sans ça, un fichier relié plus tard relancerait par un Title ID dont la copie Vita3K n'existe plus.
  else if (action === 'file') db.prepare('UPDATE library SET missing = 1, vita_title_id = NULL WHERE id = ?').run(id)
}

/**
 * Désinstalle les mises à jour et DLC d'un jeu (un par un, voir `uninstallContent` : l'émulateur d'abord, puis le rangement de Kartouche, puis la ligne). Un contenu
 * que l'émulateur refuse de retirer (ouvert…) est conservé tel quel, avec son état, pour pouvoir être retiré ensuite ; les suivants ne sont pas bloqués.
 * Sans dossier de ROM connu, rien n'est supprimé (on ne sait pas distinguer ce que Kartouche a rangé).
 */
async function uninstallAllContent(db: DatabaseSync, libraryId: number, romsDir: string | undefined): Promise<void> {
  if (!romsDir) return
  const ids = db.prepare('SELECT id FROM library_content WHERE library_id = ?').all(libraryId) as { id: number }[]
  for (const c of ids) await uninstallContent(db, c.id, romsDir).catch(() => undefined)
}

/** Vide entièrement la bibliothèque (action « Actions dangereuses » des réglages) ; les fichiers ROM ne sont pas touchés, et les contenus rangés attendent leur jeu. */
export function clearLibrary(db: DatabaseSync): void {
  for (const g of db.prepare('SELECT id FROM library').all() as { id: number }[]) parkContent(db, g.id)
  db.exec('DELETE FROM library')
}

/** Supprime le fichier ROM de tous les jeux (action « Actions dangereuses ») ainsi que leurs mises à jour/DLC ; `refreshMissing` marquera les entrées sans fichier au prochain chargement. */
export async function deleteAllRomFiles(db: DatabaseSync, romsDir?: string): Promise<void> {
  const rows = db.prepare('SELECT id, path FROM library WHERE missing = 0').all() as { id: number; path: string }[]
  for (const r of rows) { await deleteRomFiles(r.path); await uninstallAllContent(db, r.id, romsDir) }
}

/** Mises à jour/DLC rattachés à un jeu de la bibliothèque (voir `library/content/`). */
export function listContent(db: DatabaseSync, libraryId: number): LibraryContentItem[] {
  return (db.prepare('SELECT id, kind, title_id, version, label, size, added_at, state, reason, needs, detail FROM library_content WHERE library_id = ? ORDER BY kind, label COLLATE NOCASE').all(libraryId) as unknown as
    { id: number; kind: string; title_id: string | null; version: string | null; label: string; size: number; added_at: number; state: string; reason: string | null; needs: string | null; detail: string | null }[])
    .map((r) => ({ id: r.id, kind: r.kind as 'update' | 'dlc', titleId: r.title_id, version: r.version, label: r.label, size: r.size, addedAt: r.added_at, state: r.state as LibraryContentItem['state'], reason: r.reason, needs: r.needs, detail: r.detail }))
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
