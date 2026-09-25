import type { DatabaseSync } from 'node:sqlite'
import type { CatalogGame, CatalogPage, CatalogQuery } from '@shared/catalog'
import { displayTitle } from '@shared/catalog'
import { matchKey } from './popularity'

export interface CatalogRow {
  title: string; region: string; year: number | null; genre: string | null; developer: string | null
  crc: string | null; sha1: string | null; size: number | null; variant: boolean
  /** Fournis directement par la source (Switch/IGDB) ; sinon la popularité est conservée d'une synchro à l'autre. */
  popularity?: number | null; img?: string | null
}

/** Remplace le contenu d'une console dans une seule transaction. */
export function replaceConsole(db: DatabaseSync, consoleId: string, rows: CatalogRow[], version: string | null, now = Date.now()): void {
  db.exec('BEGIN')
  try {
    // La popularité vient d'IGDB, pas des DAT : on la conserve à travers une resynchronisation.
    const pop = new Map((db.prepare('SELECT title, popularity FROM catalog_games WHERE console = ? AND popularity IS NOT NULL').all(consoleId) as { title: string; popularity: number }[]).map((r) => [r.title, r.popularity]))
    db.prepare('DELETE FROM catalog_games WHERE console = ?').run(consoleId)
    const ins = db.prepare(`INSERT OR IGNORE INTO catalog_games (console, title, name, region, year, genre, developer, crc, sha1, size, variant, popularity, base, img)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const r of rows) ins.run(consoleId, r.title, displayTitle(r.title), r.region, r.year, r.genre, r.developer, r.crc, r.sha1, r.size, r.variant ? 1 : 0, r.popularity ?? pop.get(r.title) ?? null, matchKey(r.title), r.img ?? null)
    db.prepare(`INSERT INTO catalog_sync (console, version, synced_at, count) VALUES (?, ?, ?, ?)
      ON CONFLICT(console) DO UPDATE SET version = excluded.version, synced_at = excluded.synced_at, count = excluded.count`)
      .run(consoleId, version, now, rows.length)
    markDuplicates(db, consoleId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Version européenne d'abord, puis monde, puis USA (la région n'est pas affichée : elle ne sert qu'à choisir la version représentative). */
const regionRank = (r: string): number => (/Europe|France|Spain|Italy|Germany/.test(r) ? 0 : /World/.test(r) ? 1 : /USA/.test(r) ? 2 : 3)

/** Garde une seule entrée par jeu et par console (base de titre identique) : non-variante, Europe puis monde puis USA, titre le plus court. Les autres passent en `dup`. */
export function markDuplicates(db: DatabaseSync, consoleId: string): void {
  const rows = db.prepare('SELECT id, title, region, variant, base FROM catalog_games WHERE console = ?').all(consoleId) as { id: number; title: string; region: string; variant: number; base: string | null }[]
  const best = new Map<string, typeof rows[number]>()
  const better = (a: typeof rows[number], b: typeof rows[number]): boolean =>
    a.variant !== b.variant ? a.variant < b.variant : regionRank(a.region) !== regionRank(b.region) ? regionRank(a.region) < regionRank(b.region) : a.title.length < b.title.length
  for (const r of rows) {
    if (!r.base) continue
    const cur = best.get(r.base)
    if (!cur || better(r, cur)) best.set(r.base, r)
  }
  const upd = db.prepare('UPDATE catalog_games SET dup = ? WHERE id = ?')
  for (const r of rows) upd.run(r.base && best.get(r.base)!.id !== r.id ? 1 : 0, r.id)
}

/** Recalcule les colonnes dérivées (titre lisible, regroupement) de tout le catalogue ; appelé quand la règle change. */
export function rebuildDerived(db: DatabaseSync): void {
  db.exec('BEGIN')
  try {
    const rows = db.prepare('SELECT id, title FROM catalog_games').all() as { id: number; title: string }[]
    const upd = db.prepare('UPDATE catalog_games SET name = ?, base = ? WHERE id = ?')
    for (const r of rows) upd.run(displayTitle(r.title), matchKey(r.title), r.id)
    for (const c of db.prepare('SELECT DISTINCT console FROM catalog_games').all() as { console: string }[]) markDuplicates(db, c.console)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

/** Supprime les consoles qui ne sont plus au catalogue (ex. retirées de la liste des émulateurs pris en charge). */
export function pruneUnknownConsoles(db: DatabaseSync, keep: string[]): void {
  const marks = keep.map(() => '?').join(',')
  db.prepare(`DELETE FROM catalog_games WHERE console NOT IN (${marks})`).run(...keep)
  db.prepare(`DELETE FROM catalog_sync WHERE console NOT IN (${marks})`).run(...keep)
}

export const catalogCount = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM catalog_games').get() as { n: number }).n

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c)

function where(q: CatalogQuery, skip?: 'consoles' | 'genres'): { sql: string; args: (string | number)[] } {
  const parts: string[] = []
  const args: (string | number)[] = []
  if (!q.includeVariants) parts.push('variant = 0 AND dup = 0')
  const text = q.q?.trim()
  if (text) {
    for (const w of text.split(/\s+/)) { parts.push("name LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(w)}%`) }
  }
  if (skip !== 'consoles' && q.consoles?.length) { parts.push(`console IN (${q.consoles.map(() => '?').join(',')})`); args.push(...q.consoles) }
  if (skip !== 'genres' && q.genres?.length) { parts.push(`genre IN (${q.genres.map(() => '?').join(',')})`); args.push(...q.genres) }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args }
}

const ORDER = {
  title: 'name COLLATE NOCASE',
  year: 'year IS NULL, year DESC, name COLLATE NOCASE',
  // Score IGDB quand il existe ; sans lui, on privilégie les jeux documentés (genre connu) puis les sorties US/monde.
  popularity: "popularity IS NULL, popularity DESC, genre IS NULL, name COLLATE NOCASE"
} as const

/** Les facettes ignorent leur propre filtre pour que l'utilisateur voie les autres choix possibles. */
export function queryCatalog(db: DatabaseSync, q: CatalogQuery): CatalogPage {
  const w = where(q)
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 500)
  const offset = Math.max(q.offset ?? 0, 0)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM catalog_games ${w.sql}`).get(...w.args) as { n: number }).n
  const games = db.prepare(`SELECT id, console, title, name, region, year, genre, developer, crc, sha1, size, popularity, img FROM catalog_games ${w.sql}
    ORDER BY ${ORDER[q.sort ?? 'popularity']} LIMIT ? OFFSET ?`).all(...w.args, limit, offset) as unknown as CatalogGame[]
  const wc = where(q, 'consoles')
  const consoles = db.prepare(`SELECT console AS id, COUNT(*) AS count FROM catalog_games ${wc.sql} GROUP BY console ORDER BY count DESC`).all(...wc.args) as { id: string; count: number }[]
  const wg = where(q, 'genres')
  const genres = db.prepare(`SELECT genre AS name, COUNT(*) AS count FROM catalog_games ${wg.sql ? wg.sql + ' AND' : 'WHERE'} genre IS NOT NULL
    GROUP BY genre ORDER BY count DESC`).all(...wg.args) as { name: string; count: number }[]
  return { total, games, consoles, genres }
}

export function getGame(db: DatabaseSync, id: number): CatalogGame | null {
  return (db.prepare('SELECT id, console, title, name, region, year, genre, developer, crc, sha1, size, popularity, img FROM catalog_games WHERE id = ?').get(id) as unknown as CatalogGame | undefined) ?? null
}
