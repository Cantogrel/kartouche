import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import type { GameSource, SourceListRefreshAllResult, SourceListRefreshResult, SourceListSummary } from '@shared/sourceList'
import { formatValidationErrors, validateSourceList } from './validate'
import { defaultFetch, insertEntries, type Fetcher } from './import'
import { isHttpUrl, removeCopy, saveCopy } from './localCopy'

interface SourceListRow {
  id: number
  name: string
  url: string
  homepage: string | null
  added_at: number
  last_refreshed_at: number | null
  entry_count: number
  error: string | null
  local_copy: string | null
  matched_count: number
}

/** Listes déjà ajoutées, avec le nombre d'entrées reconnues dans le catalogue. */
export function listSourceLists(db: DatabaseSync): SourceListSummary[] {
  const rows = db.prepare(`SELECT sl.id, sl.name, sl.url, sl.homepage, sl.added_at, sl.last_refreshed_at, sl.entry_count, sl.error, sl.local_copy,
      (SELECT COUNT(*) FROM sources WHERE list_id = sl.id AND matched = 1) AS matched_count
    FROM source_lists sl ORDER BY sl.added_at`).all() as unknown as SourceListRow[]
  return rows.map((r) => ({
    id: r.id, name: r.name, url: r.url, homepage: r.homepage, addedAt: r.added_at, lastRefreshedAt: r.last_refreshed_at,
    entryCount: r.entry_count, matchedCount: r.matched_count, error: r.error,
    hasLocalCopy: !!r.local_copy && existsSync(r.local_copy), localCopyPath: r.local_copy && existsSync(r.local_copy) ? r.local_copy : null
  }))
}

/**
 * Re-télécharge et revalide une liste. Un échec (réseau ou validation) se contente de renseigner
 * `error` : les sources déjà importées restent en base, jamais perdues sur un accès indisponible.
 */
export async function refreshSourceList(db: DatabaseSync, listId: number, fetcher: Fetcher = defaultFetch, now = Date.now(), storeDir?: string): Promise<SourceListRefreshResult> {
  const list = db.prepare('SELECT url, local_copy FROM source_lists WHERE id = ?').get(listId) as { url: string; local_copy: string | null } | undefined
  if (!list) throw new Error('liste introuvable')

  const fail = (message: string): SourceListRefreshResult => {
    db.prepare('UPDATE source_lists SET error = ? WHERE id = ?').run(message, listId)
    return { ok: false, error: message }
  }

  // Fichier local : la source de vérité est la copie gardée dans le dossier de données, jamais le fichier d'origine (qui peut avoir été déplacé ou supprimé).
  // Pour la modifier, on édite cette copie. Une liste d'avant les copies en reçoit une maintenant, tant que son original existe encore.
  const local = !isHttpUrl(list.url)
  let source = list.url
  if (local) {
    let copy = list.local_copy && existsSync(list.local_copy) ? list.local_copy : null
    if (!copy && storeDir && existsSync(list.url)) {
      try { copy = saveCopy(storeDir, list.url, JSON.parse(readFileSync(list.url, 'utf8'))) } catch { /* original illisible : pas de copie */ }
    }
    if (!copy) return fail(`copie locale introuvable (${list.url})`)
    source = copy
  }
  let data: unknown
  try {
    data = await fetcher(source)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }

  const result = validateSourceList(data)
  if (!result.ok) return fail(`liste invalide : ${formatValidationErrors(result.errors)}`)
  const doc = result.document
  const copy = local ? source : list.local_copy

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM sources WHERE list_id = ?').run(listId)
    const matchedCount = insertEntries(db, listId, doc)
    db.prepare(`UPDATE source_lists SET name = ?, homepage = ?, generated_at = ?, last_refreshed_at = ?, entry_count = ?, error = NULL, local_copy = ? WHERE id = ?`)
      .run(doc.name, doc.homepage ?? null, doc.generatedAt ? (Date.parse(doc.generatedAt) || null) : null, now, doc.entries.length, copy, listId)
    db.exec('COMMIT')
    return { ok: true, entryCount: doc.entries.length, matchedCount }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Retire une liste (et sa copie locale) ; ses sources partent en cascade (ON DELETE CASCADE), les autres listes ne sont pas touchées. */
export function removeSourceList(db: DatabaseSync, listId: number): void {
  const row = db.prepare('SELECT local_copy FROM source_lists WHERE id = ?').get(listId) as { local_copy: string | null } | undefined
  db.prepare('DELETE FROM source_lists WHERE id = ?').run(listId)
  removeCopy(row?.local_copy)
}

/** Retire toutes les listes, leurs sources et leurs copies locales. La bibliothèque et le catalogue ne sont pas touchés. */
export function removeAllSourceLists(db: DatabaseSync): void {
  const copies = db.prepare('SELECT local_copy FROM source_lists').all() as { local_copy: string | null }[]
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM sources; DELETE FROM source_lists')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  for (const c of copies) removeCopy(c.local_copy)
}

/** Actualise toutes les listes l'une après l'autre ; une liste en échec n'arrête pas les suivantes (son erreur reste affichée sur elle). */
export async function refreshAllSourceLists(db: DatabaseSync, fetcher: Fetcher = defaultFetch, now = Date.now(), storeDir?: string): Promise<SourceListRefreshAllResult> {
  const lists = db.prepare('SELECT id, name FROM source_lists ORDER BY added_at').all() as { id: number; name: string }[]
  const out: SourceListRefreshAllResult = { refreshed: 0, failed: [] }
  for (const l of lists) {
    const r = await refreshSourceList(db, l.id, fetcher, now, storeDir).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
    if (r.ok) out.refreshed++
    else out.failed.push({ name: l.name, error: r.error ?? '' })
  }
  return out
}

interface GameSourceRow {
  id: number
  list_name: string
  title: string
  size_bytes: number | null
  note: string | null
  uris: string
}

/** Sources rapprochées d'un jeu précis du catalogue (fiche jeu) ; vide si aucune liste n'en propose. */
export function sourcesForGame(db: DatabaseSync, gameId: number): GameSource[] {
  const rows = db.prepare(`SELECT s.id, sl.name AS list_name, s.title, s.size_bytes, s.note, s.uris
    FROM sources s JOIN source_lists sl ON sl.id = s.list_id
    WHERE s.game_id = ? AND s.matched = 1 ORDER BY sl.name`).all(gameId) as unknown as GameSourceRow[]
  return rows.map((r) => ({ id: r.id, listName: r.list_name, title: r.title, sizeBytes: r.size_bytes, note: r.note, uris: JSON.parse(r.uris) as string[] }))
}
