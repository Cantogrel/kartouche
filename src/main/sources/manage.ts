import type { DatabaseSync } from 'node:sqlite'
import type { SourceListRefreshResult } from '@shared/sourceList'
import { validateSourceList } from './validate'
import { defaultFetch, insertEntries, type Fetcher } from './import'

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
