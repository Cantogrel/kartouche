import type { DatabaseSync } from 'node:sqlite'
import type { SourceListDocument, SourceListImportResult } from '@shared/sourceList'
import { validateSourceList } from './validate'
import { normalizeTitle } from '../achievements/retroachievements'

export type Fetcher = (url: string) => Promise<unknown>

export const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'RomVault' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Rapprochement titre+console → id catalogue, mis en cache par console le temps d'un import (évite une requête par entrée). */
export class CatalogMatcher {
  private readonly byConsole = new Map<string, Map<string, number>>()
  constructor(private readonly db: DatabaseSync) {}

  match(console: string, title: string): number | null {
    let norm = this.byConsole.get(console)
    if (!norm) {
      norm = new Map()
      const rows = this.db.prepare('SELECT id, title FROM catalog_games WHERE console = ?').all(console) as { id: number; title: string }[]
      for (const r of rows) { const n = normalizeTitle(r.title); if (n && !norm.has(n)) norm.set(n, r.id) }
      this.byConsole.set(console, norm)
    }
    const n = normalizeTitle(title)
    return n ? (norm.get(n) ?? null) : null
  }
}

export function insertEntries(db: DatabaseSync, listId: number, doc: SourceListDocument): number {
  const matcher = new CatalogMatcher(db)
  const ins = db.prepare(`INSERT INTO sources (list_id, game_id, console, title, size_bytes, crc, sha1, uris, note, matched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  let matched = 0
  for (const e of doc.entries) {
    const gameId = matcher.match(e.console, e.title)
    if (gameId !== null) matched++
    ins.run(listId, gameId, e.console, e.title, e.sizeBytes ?? null, e.hash?.crc32 ?? null, e.hash?.sha1 ?? null, JSON.stringify(e.uris), e.note ?? null, gameId !== null ? 1 : 0)
  }
  return matched
}

/** Ajoute une liste (URL fournie par l'utilisateur), la valide et rapproche ses entrées du catalogue. */
export async function addSourceList(db: DatabaseSync, url: string, fetcher: Fetcher = defaultFetch, now = Date.now()): Promise<SourceListImportResult> {
  const existing = db.prepare('SELECT id FROM source_lists WHERE url = ?').get(url)
  if (existing) throw new Error('cette liste a déjà été ajoutée')

  const data = await fetcher(url)
  const result = validateSourceList(data)
  if (!result.ok) throw new Error(`liste invalide : ${result.errors.map((e) => `${e.path || '(racine)'} — ${e.message}`).join('; ')}`)
  const doc = result.document

  db.exec('BEGIN')
  try {
    db.prepare(`INSERT INTO source_lists (name, url, homepage, generated_at, added_at, last_refreshed_at, entry_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(doc.name, url, doc.homepage ?? null, doc.generatedAt ? (Date.parse(doc.generatedAt) || null) : null, now, now, doc.entries.length)
    const listId = (db.prepare('SELECT id FROM source_lists WHERE url = ?').get(url) as { id: number }).id
    const matchedCount = insertEntries(db, listId, doc)
    db.exec('COMMIT')
    return { listId, name: doc.name, entryCount: doc.entries.length, matchedCount }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
