import type { DatabaseSync } from 'node:sqlite'
import type { SourceListRefreshResult, SourceListSummary } from '@shared/sourceList'
import { validateSourceList } from './validate'
import { defaultFetch, insertEntries, type Fetcher } from './import'

interface SourceListRow {
  id: number
  name: string
  url: string
  homepage: string | null
  added_at: number
  last_refreshed_at: number | null
  entry_count: number
  error: string | null
  matched_count: number
}

/** Listes déjà ajoutées, avec le nombre d'entrées reconnues dans le catalogue. */
export function listSourceLists(db: DatabaseSync): SourceListSummary[] {
  const rows = db.prepare(`SELECT sl.id, sl.name, sl.url, sl.homepage, sl.added_at, sl.last_refreshed_at, sl.entry_count, sl.error,
      (SELECT COUNT(*) FROM sources WHERE list_id = sl.id AND matched = 1) AS matched_count
    FROM source_lists sl ORDER BY sl.added_at`).all() as unknown as SourceListRow[]
  return rows.map((r) => ({
    id: r.id, name: r.name, url: r.url, homepage: r.homepage, addedAt: r.added_at, lastRefreshedAt: r.last_refreshed_at,
    entryCount: r.entry_count, matchedCount: r.matched_count, error: r.error
  }))
}

/**
 * Re-télécharge et revalide une liste. Un échec (réseau ou validation) se contente de renseigner
 * `error` : les sources déjà importées restent en base, jamais perdues sur un accès indisponible.
 */
export async function refreshSourceList(db: DatabaseSync, listId: number, fetcher: Fetcher = defaultFetch, now = Date.now()): Promise<SourceListRefreshResult> {
  const list = db.prepare('SELECT url FROM source_lists WHERE id = ?').get(listId) as { url: string } | undefined
  if (!list) throw new Error('liste introuvable')

  const fail = (message: string): SourceListRefreshResult => {
    db.prepare('UPDATE source_lists SET error = ? WHERE id = ?').run(message, listId)
    return { ok: false, error: message }
  }

  let data: unknown
  try {
    data = await fetcher(list.url)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }

  const result = validateSourceList(data)
  if (!result.ok) return fail(`liste invalide : ${result.errors.map((e) => `${e.path || '(racine)'} — ${e.message}`).join('; ')}`)
  const doc = result.document

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM sources WHERE list_id = ?').run(listId)
    const matchedCount = insertEntries(db, listId, doc)
    db.prepare(`UPDATE source_lists SET name = ?, homepage = ?, generated_at = ?, last_refreshed_at = ?, entry_count = ?, error = NULL WHERE id = ?`)
      .run(doc.name, doc.homepage ?? null, doc.generatedAt ? (Date.parse(doc.generatedAt) || null) : null, now, doc.entries.length, listId)
    db.exec('COMMIT')
    return { ok: true, entryCount: doc.entries.length, matchedCount }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Retire une liste ; ses sources partent en cascade (ON DELETE CASCADE), les autres listes ne sont pas touchées. */
export function removeSourceList(db: DatabaseSync, listId: number): void {
  db.prepare('DELETE FROM source_lists WHERE id = ?').run(listId)
}
