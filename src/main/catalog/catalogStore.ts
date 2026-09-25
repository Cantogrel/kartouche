import type { DatabaseSync } from 'node:sqlite'
import type { CatalogGame, CatalogPage, CatalogQuery } from '@shared/catalog'

export interface CatalogRow {
  title: string; region: string; year: number | null; genre: string | null; developer: string | null
  crc: string | null; sha1: string | null; size: number | null; variant: boolean
}

/** Remplace le contenu d'une console dans une seule transaction. */
export function replaceConsole(db: DatabaseSync, consoleId: string, rows: CatalogRow[], version: string | null, now = Date.now()): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM catalog_games WHERE console = ?').run(consoleId)
    const ins = db.prepare(`INSERT OR IGNORE INTO catalog_games (console, title, region, year, genre, developer, crc, sha1, size, variant)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const r of rows) ins.run(consoleId, r.title, r.region, r.year, r.genre, r.developer, r.crc, r.sha1, r.size, r.variant ? 1 : 0)
    db.prepare(`INSERT INTO catalog_sync (console, version, synced_at, count) VALUES (?, ?, ?, ?)
      ON CONFLICT(console) DO UPDATE SET version = excluded.version, synced_at = excluded.synced_at, count = excluded.count`)
      .run(consoleId, version, now, rows.length)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export const catalogCount = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM catalog_games').get() as { n: number }).n

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c)

function where(q: CatalogQuery, skip?: 'consoles' | 'genres'): { sql: string; args: (string | number)[] } {
  const parts: string[] = []
  const args: (string | number)[] = []
  if (!q.includeVariants) parts.push('variant = 0')
  const text = q.q?.trim()
  if (text) {
    for (const w of text.split(/\s+/)) { parts.push("title LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(w)}%`) }
  }
  if (skip !== 'consoles' && q.consoles?.length) { parts.push(`console IN (${q.consoles.map(() => '?').join(',')})`); args.push(...q.consoles) }
  if (skip !== 'genres' && q.genres?.length) { parts.push(`genre IN (${q.genres.map(() => '?').join(',')})`); args.push(...q.genres) }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args }
}

const ORDER = {
  title: 'title COLLATE NOCASE',
  year: 'year IS NULL, year DESC, title COLLATE NOCASE',
  // Pas de donnée de popularité hors ligne : on privilégie les sorties mondiales/US puis l'ordre alphabétique.
  popularity: "(region LIKE '%USA%' OR region LIKE '%World%') DESC, title COLLATE NOCASE"
} as const

/** Les facettes ignorent leur propre filtre pour que l'utilisateur voie les autres choix possibles. */
export function queryCatalog(db: DatabaseSync, q: CatalogQuery): CatalogPage {
  const w = where(q)
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 500)
  const offset = Math.max(q.offset ?? 0, 0)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM catalog_games ${w.sql}`).get(...w.args) as { n: number }).n
  const games = db.prepare(`SELECT id, console, title, region, year, genre, developer, crc, sha1, size FROM catalog_games ${w.sql}
    ORDER BY ${ORDER[q.sort ?? 'popularity']} LIMIT ? OFFSET ?`).all(...w.args, limit, offset) as unknown as CatalogGame[]
  const wc = where(q, 'consoles')
  const consoles = db.prepare(`SELECT console AS id, COUNT(*) AS count FROM catalog_games ${wc.sql} GROUP BY console ORDER BY count DESC`).all(...wc.args) as { id: string; count: number }[]
  const wg = where(q, 'genres')
  const genres = db.prepare(`SELECT genre AS name, COUNT(*) AS count FROM catalog_games ${wg.sql ? wg.sql + ' AND' : 'WHERE'} genre IS NOT NULL
    GROUP BY genre ORDER BY count DESC`).all(...wg.args) as { name: string; count: number }[]
  return { total, games, consoles, genres }
}

export function getGame(db: DatabaseSync, id: number): CatalogGame | null {
  return (db.prepare('SELECT id, console, title, region, year, genre, developer, crc, sha1, size FROM catalog_games WHERE id = ?').get(id) as unknown as CatalogGame | undefined) ?? null
}
