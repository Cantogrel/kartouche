import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import type { SourceListDocument, SourceListImportResult } from '@shared/sourceList'
import { formatValidationErrors, validateSourceList } from './validate'
import { CatalogMatcher } from './matcher'
import { isHttpUrl, removeCopy, saveCopy } from './localCopy'

export { CatalogMatcher }

export type Fetcher = (url: string) => Promise<unknown>


export const defaultFetch: Fetcher = async (url) => {
  if (!isHttpUrl(url)) return JSON.parse(await readFile(url, 'utf8'))
  const res = await fetch(url, { headers: { 'user-agent': 'RomVault' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function insertEntries(db: DatabaseSync, listId: number, doc: SourceListDocument): number {
  const matcher = new CatalogMatcher(db)
  const ins = db.prepare(`INSERT INTO sources (list_id, game_id, console, title, size_bytes, crc, sha1, uris, note, matched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  let matched = 0
  for (const e of doc.entries) {
    const gameId = matcher.match({ console: e.console, title: e.title, sizeBytes: e.sizeBytes, crc: e.hash?.crc32, sha1: e.hash?.sha1 })?.gameId ?? null
    if (gameId !== null) matched++
    ins.run(listId, gameId, e.console, e.title, e.sizeBytes ?? null, e.hash?.crc32 ?? null, e.hash?.sha1 ?? null, JSON.stringify(e.uris), e.note ?? null, gameId !== null ? 1 : 0)
  }
  return matched
}

/** Ajoute une liste (URL fournie par l'utilisateur), la valide et rapproche ses entrées du catalogue. */
export async function addSourceList(db: DatabaseSync, url: string, fetcher: Fetcher = defaultFetch, now = Date.now(), storeDir?: string): Promise<SourceListImportResult> {
  const existing = db.prepare('SELECT id FROM source_lists WHERE url = ?').get(url)
  if (existing) throw new Error('cette liste a déjà été ajoutée')

  const data = await fetcher(url)
  const result = validateSourceList(data)
  if (!result.ok) throw new Error(`liste invalide : ${formatValidationErrors(result.errors)}`)
  const doc = result.document
  // Un fichier local est copié dans le dossier de données : la liste reste actualisable même si le fichier d'origine disparaît.
  const localCopy = storeDir && !isHttpUrl(url) ? saveCopy(storeDir, url, data) : null

  db.exec('BEGIN')
  try {
    db.prepare(`INSERT INTO source_lists (name, url, homepage, generated_at, added_at, last_refreshed_at, entry_count, local_copy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(doc.name, url, doc.homepage ?? null, doc.generatedAt ? (Date.parse(doc.generatedAt) || null) : null, now, now, doc.entries.length, localCopy)
    const listId = (db.prepare('SELECT id FROM source_lists WHERE url = ?').get(url) as { id: number }).id
    const matchedCount = insertEntries(db, listId, doc)
    db.exec('COMMIT')
    return { listId, name: doc.name, entryCount: doc.entries.length, matchedCount }
  } catch (e) {
    db.exec('ROLLBACK')
    removeCopy(localCopy)
    throw e
  }
}

/** Version de l'algorithme de rapprochement : à incrémenter quand il change, pour re-rapprocher les listes déjà importées. */
export const SOURCE_MATCH_VERSION = '2'

/**
 * Recalcule `game_id` / `matched` de toutes les sources déjà importées avec le matcher courant, sans retélécharger les listes.
 * Appelé au démarrage quand la version change et après une synchro du catalogue (de nouveaux jeux peuvent exister).
 */
export function rematchSources(db: DatabaseSync): { total: number; matched: number } {
  const matcher = new CatalogMatcher(db)
  const rows = db.prepare('SELECT id, console, title, size_bytes, crc, sha1, game_id FROM sources').all() as unknown as
    { id: number; console: string; title: string; size_bytes: number | null; crc: string | null; sha1: string | null; game_id: number | null }[]
  const upd = db.prepare('UPDATE sources SET game_id = ?, matched = ? WHERE id = ?')
  let matched = 0
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const gameId = matcher.match({ console: r.console, title: r.title, sizeBytes: r.size_bytes, crc: r.crc, sha1: r.sha1 })?.gameId ?? null
      if (gameId !== null) matched++
      if (gameId !== r.game_id) upd.run(gameId, gameId !== null ? 1 : 0, r.id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { total: rows.length, matched }
}
