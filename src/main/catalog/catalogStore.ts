import type { DatabaseSync } from 'node:sqlite'
import type { CatalogGame, CatalogPage, CatalogQuery } from '@shared/catalog'
import { displayTitle } from '@shared/catalog'
import { canonicalGenre } from '@shared/genres'
import { PUBLISHER_OTHER, PUBLISHERS } from '@shared/publishers'
import { matchKey } from './popularity'

export interface CatalogRow {
  title: string; region: string; year: number | null; genre: string | null; developer: string | null
  crc: string | null; sha1: string | null; size: number | null; variant: boolean
  /** Fournis directement par la source (Switch/IGDB) ; sinon la popularité est conservée d'une synchro à l'autre. */
  popularity?: number | null; img?: string | null
}

/**
 * Remplace le contenu d'une console dans une seule transaction, en gardant le même `id` pour un jeu qui existait déjà
 * (upsert sur la clé naturelle `UNIQUE (console, title)`) : `library.game_id` n'est PAS une clé étrangère déclarée
 * (une ROM peut être importée avant que son jeu existe au catalogue), donc rien n'empêchait un ancien DELETE + INSERT
 * de changer les id et d'orpheliner silencieusement tous les jeux déjà importés à chaque resynchro — voir
 * `relinkUnmatched`, qui rattrape après coup les entrées restées orphelines malgré tout (jeu renommé à la source…).
 * Un jeu disparu de la source n'est supprimé que s'il n'est référencé par aucune entrée de bibliothèque.
 */
export function replaceConsole(db: DatabaseSync, consoleId: string, rows: CatalogRow[], version: string | null, now = Date.now()): void {
  db.exec('BEGIN')
  try {
    // Popularité, genre, développeur et année viennent en partie d'IGDB, pas des DAT : on les conserve à travers une resynchronisation.
    type Prev = { popularity: number | null; genre: string | null; developer: string | null; year: number | null }
    const prev = new Map((db.prepare('SELECT title, popularity, genre, developer, year FROM catalog_games WHERE console = ?').all(consoleId) as (Prev & { title: string })[]).map((r) => [r.title, r]))
    const upsert = db.prepare(`INSERT INTO catalog_games (console, title, name, region, year, genre, developer, crc, sha1, size, variant, popularity, base, img)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (console, title) DO UPDATE SET
        name = excluded.name, region = excluded.region, year = excluded.year, genre = excluded.genre, developer = excluded.developer,
        crc = excluded.crc, sha1 = excluded.sha1, size = excluded.size, variant = excluded.variant, popularity = excluded.popularity,
        base = excluded.base, img = excluded.img`)
    const seen = new Set<string>()
    for (const r of rows) {
      seen.add(r.title)
      const p = prev.get(r.title)
      upsert.run(consoleId, r.title, displayTitle(r.title), r.region, r.year ?? p?.year ?? null, canonicalGenre(r.genre) ?? p?.genre ?? null, r.developer ?? p?.developer ?? null,
        r.crc, r.sha1, r.size, r.variant ? 1 : 0, r.popularity ?? p?.popularity ?? null, matchKey(r.title), r.img ?? null)
    }
    const gone = [...prev.keys()].filter((title) => !seen.has(title))
    if (gone.length) {
      const del = db.prepare(`DELETE FROM catalog_games WHERE console = ? AND title = ?
        AND NOT EXISTS (SELECT 1 FROM library WHERE game_id = catalog_games.id)
        AND NOT EXISTS (SELECT 1 FROM sources WHERE game_id = catalog_games.id)`)
      for (const title of gone) del.run(consoleId, title)
    }
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
    const upd = db.prepare('UPDATE catalog_games SET name = ?, base = ?, genre = ? WHERE id = ?')
    const genres = db.prepare('SELECT id, genre FROM catalog_games').all() as { id: number; genre: string | null }[]
    const genreOf = new Map(genres.map((g) => [g.id, g.genre]))
    for (const r of rows) upd.run(displayTitle(r.title), matchKey(r.title), canonicalGenre(genreOf.get(r.id)), r.id)
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
const likeAny = (col: string, needles: string[]): { sql: string; args: string[] } =>
  ({ sql: `(${needles.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`, args: needles.map((n) => `%${escapeLike(n)}%`) })

/**
 * Clause d'un éditeur (`PublisherDef.id`, ou `PUBLISHER_OTHER`) : `developer` n'est qu'un nom de studio venu des DAT
 * ou d'IGDB, pas un vrai champ éditeur — voir shared/publishers.ts. `'other'`/un id inconnu = ni vide ni reconnu.
 */
function publisherClause(id: string): { sql: string; args: string[] } {
  const def = PUBLISHERS.find((p) => p.id === id)
  if (def) return likeAny('developer', def.match)
  const any = likeAny('developer', PUBLISHERS.flatMap((p) => p.match))
  return { sql: `(developer IS NULL OR NOT ${any.sql})`, args: any.args }
}

function publishersClause(ids: string[]): { sql: string; args: string[] } {
  const parts = ids.map(publisherClause)
  return { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, args: parts.flatMap((p) => p.args) }
}

function where(q: CatalogQuery, skip?: 'consoles' | 'genres' | 'publishers'): { sql: string; args: (string | number)[] } {
  const parts: string[] = []
  const args: (string | number)[] = []
  if (!q.includeVariants) parts.push('variant = 0 AND dup = 0')
  const text = q.q?.trim()
  if (text) {
    for (const w of text.split(/\s+/)) { parts.push("name LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(w)}%`) }
  }
  if (skip !== 'consoles' && q.consoles?.length) { parts.push(`console IN (${q.consoles.map(() => '?').join(',')})`); args.push(...q.consoles) }
  if (skip !== 'genres' && q.genres?.length) { parts.push(`genre IN (${q.genres.map(() => '?').join(',')})`); args.push(...q.genres) }
  if (skip !== 'publishers' && q.publishers?.length) { const c = publishersClause(q.publishers); parts.push(c.sql); args.push(...c.args) }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args }
}

/** Tri par défaut de chaque critère : les plus populaires et les plus récents d'abord, le titre de A à Z. Les valeurs inconnues passent toujours en dernier. */
export const DEFAULT_DIR = { popularity: 'desc', year: 'desc', title: 'asc' } as const

function orderBy(sort: CatalogQuery['sort'] = 'popularity', dir?: 'asc' | 'desc'): string {
  const d = (dir ?? DEFAULT_DIR[sort]) === 'asc' ? 'ASC' : 'DESC'
  if (sort === 'title') return `name COLLATE NOCASE ${d}`
  if (sort === 'year') return `year IS NULL, year ${d}, name COLLATE NOCASE`
  // Sans score de popularité, on privilégie les jeux documentés (genre connu).
  return `popularity IS NULL, popularity ${d}, genre IS NULL, name COLLATE NOCASE`
}

/** Les facettes ignorent leur propre filtre pour que l'utilisateur voie les autres choix possibles. */
export function queryCatalog(db: DatabaseSync, q: CatalogQuery): CatalogPage {
  const w = where(q)
  const limit = Math.min(Math.max(q.limit ?? 60, 1), 500)
  const offset = Math.max(q.offset ?? 0, 0)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM catalog_games ${w.sql}`).get(...w.args) as { n: number }).n
  const games = db.prepare(`SELECT id, console, title, name, region, year, genre, developer, crc, sha1, size, popularity, img FROM catalog_games ${w.sql}
    ORDER BY ${orderBy(q.sort, q.dir)} LIMIT ? OFFSET ?`).all(...w.args, limit, offset) as unknown as CatalogGame[]
  const wc = where(q, 'consoles')
  const consoles = db.prepare(`SELECT console AS id, COUNT(*) AS count FROM catalog_games ${wc.sql} GROUP BY console ORDER BY count DESC`).all(...wc.args) as { id: string; count: number }[]
  const wg = where(q, 'genres')
  const genres = db.prepare(`SELECT genre AS name, COUNT(*) AS count FROM catalog_games ${wg.sql ? wg.sql + ' AND' : 'WHERE'} genre IS NOT NULL
    GROUP BY genre ORDER BY count DESC`).all(...wg.args) as { name: string; count: number }[]
  // `developer` n'est qu'un nom de studio, pas un champ éditeur : chaque éditeur connu est sa propre requête de
  // comptage (LIKE ne se prête pas à un GROUP BY), et seuls ceux qui ont au moins un résultat sont renvoyés.
  const wp = where(q, 'publishers')
  const publishers = [...PUBLISHERS.map((p) => p.id), PUBLISHER_OTHER]
    .map((id) => {
      const c = publisherClause(id)
      const sql = wp.sql ? `${wp.sql} AND ${c.sql}` : `WHERE ${c.sql}`
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM catalog_games ${sql}`).get(...wp.args, ...c.args) as { n: number }).n
      return { id, count }
    })
    .filter((p) => p.count > 0)
  return { total, games, consoles, genres, publishers }
}

export function getGame(db: DatabaseSync, id: number): CatalogGame | null {
  return (db.prepare('SELECT id, console, title, name, region, year, genre, developer, crc, sha1, size, popularity, img FROM catalog_games WHERE id = ?').get(id) as unknown as CatalogGame | undefined) ?? null
}
