import type { DatabaseSync } from 'node:sqlite'
import type { GameStats } from '@shared/library'

const DAY_MS = 24 * 3600 * 1000

/**
 * Enregistre une session de jeu terminée (lancement générique ou émulateur). `minutes` est la durée comptée dans `library.play_minutes` (arrondie, voir
 * `sessionMinutes`) ; on la retient telle quelle pour que les statistiques restent cohérentes avec le temps de jeu affiché.
 */
export function recordPlaySession(db: DatabaseSync, entryId: number, startedAt: number, endedAt: number, minutes: number): void {
  if (!db.prepare('SELECT 1 FROM library WHERE id = ?').get(entryId)) return
  db.prepare('INSERT INTO play_sessions (entry_id, started_at, ended_at, minutes) VALUES (?, ?, ?, ?)').run(entryId, startedAt, Math.max(endedAt, startedAt), Math.max(0, Math.round(minutes)))
}

/**
 * Statistiques d'un jeu de la bibliothèque. Les sessions ne sont enregistrées que depuis la 0.3.0 : le temps de jeu total (`playMinutes`) peut donc être
 * supérieur à la somme des sessions connues ; la moyenne et la plus longue ne portent que sur celles-ci.
 */
export function getStats(db: DatabaseSync, entryId: number, now = Date.now()): GameStats | null {
  const e = db.prepare('SELECT game_id, size, added_at, play_minutes, last_played FROM library WHERE id = ?').get(entryId) as
    { game_id: number | null; size: number; added_at: number; play_minutes: number; last_played: number | null } | undefined
  if (!e) return null
  const s = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(minutes), 0) AS total, COALESCE(MAX(minutes), 0) AS longest, MIN(started_at) AS first FROM play_sessions WHERE entry_id = ?').get(entryId) as
    { n: number; total: number; longest: number; first: number | null }
  const recent = (days: number): number => (db.prepare('SELECT COALESCE(SUM(minutes), 0) AS m FROM play_sessions WHERE entry_id = ? AND started_at >= ?').get(entryId, now - days * DAY_MS) as { m: number }).m
  const played = e.play_minutes > 0
  const rank = played ? (db.prepare('SELECT COUNT(*) + 1 AS r FROM library WHERE play_minutes > ?').get(e.play_minutes) as { r: number }).r : null
  const content = (db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM library_content WHERE library_id = ?').get(entryId) as { s: number }).s
  const popularity = e.game_id !== null ? (db.prepare('SELECT popularity FROM catalog_games WHERE id = ?').get(e.game_id) as { popularity: number | null } | undefined)?.popularity ?? null : null
  return {
    playMinutes: e.play_minutes,
    sessions: s.n,
    averageSessionMinutes: s.n ? Math.round(s.total / s.n) : 0,
    longestSessionMinutes: s.longest,
    firstPlayed: s.first,
    lastPlayed: e.last_played,
    addedAt: e.added_at,
    last7DaysMinutes: recent(7),
    last30DaysMinutes: recent(30),
    rank,
    playedGames: played ? (db.prepare('SELECT COUNT(*) AS n FROM library WHERE play_minutes > 0').get() as { n: number }).n : 0,
    sizeBytes: e.size + content,
    popularity
  }
}
