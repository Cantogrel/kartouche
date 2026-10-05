import type { DatabaseSync } from 'node:sqlite'
import { RA_CONSOLES, type AchievementsResult, type Achievement, type GameAchievements } from '@shared/achievements'

const BASE = 'https://retroachievements.org/API'
/** La liste des jeux d'une console change peu : on la garde 30 jours. */
const LIST_TTL = 30 * 24 * 3600_000
/** Progression d'un jeu : rafraîchie au plus toutes les 10 minutes (sauf demande explicite, ex. après une partie). */
const PROGRESS_TTL = 10 * 60_000

export type Fetcher = (url: string) => Promise<unknown>

const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Kartouche' }, signal: AbortSignal.timeout(60_000) })
  if (res.status === 401 || res.status === 403) throw new Error('auth')
  if (!res.ok) throw new Error(`RetroAchievements HTTP ${res.status}`)
  return res.json()
}

/**
 * Titre réduit à l'essentiel pour rapprocher le catalogue (DAT No-Intro) de RetroAchievements : sans accents, sans étiquettes
 * entre parenthèses, « Legend of Zelda, The: Link » = « The Legend of Zelda - Link », lettres et chiffres seulement.
 */
export function normalizeTitle(title: string): string {
  let s = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  // Suffixe "_apfix" : convention des collections archive.org de ROMs patchées anti-piratage (ex. nds_apfix), hors nommage No-Intro.
  s = s.replace(/_apfix(\.\w+)?$/i, '')
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/^\s*~[^~]*~\s*/, '')
  // « Titre, The » (ou A / An) devant la suite éventuelle : « Legend of Zelda, The: Link » → « the legend of zelda: link ».
  s = s.replace(/^(.*?),\s*(the|a|an)\b(.*)$/, '$2 $1$3')
  s = s.replace(/^(the|a|an)\s+/, '')
  return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '')
}

interface RaListItem { ID: number; Title: string }

/** Charge (ou rafraîchit) la liste des jeux avec succès d'une console. */
export async function syncGameList(db: DatabaseSync, console: string, key: string, fetcher: Fetcher = defaultFetch, now = Date.now()): Promise<void> {
  const cid = RA_CONSOLES[console]
  if (!cid) return
  const sync = db.prepare('SELECT fetched_at FROM ra_sync WHERE console = ?').get(console) as { fetched_at: number } | undefined
  if (sync && now - sync.fetched_at < LIST_TTL) return
  const list = await fetcher(`${BASE}/API_GetGameList.php?y=${encodeURIComponent(key)}&i=${cid}&f=1`)
  if (!Array.isArray(list)) throw new Error('unexpected')
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM ra_games WHERE console = ?').run(console)
    const ins = db.prepare('INSERT OR IGNORE INTO ra_games (console, ra_id, title, norm) VALUES (?, ?, ?, ?)')
    for (const g of list as RaListItem[]) if (typeof g.ID === 'number' && typeof g.Title === 'string' && !g.Title.startsWith('~')) ins.run(console, g.ID, g.Title, normalizeTitle(g.Title))
    db.prepare('INSERT INTO ra_sync (console, fetched_at) VALUES (?, ?) ON CONFLICT(console) DO UPDATE SET fetched_at = excluded.fetched_at').run(console, now)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

/** Jeu RetroAchievements du même titre sur la même console ; null si aucun. */
export function findGame(db: DatabaseSync, console: string, title: string): { id: number; title: string } | null {
  const norm = normalizeTitle(title)
  if (!norm) return null
  const r = db.prepare('SELECT ra_id AS id, title FROM ra_games WHERE console = ? AND norm = ? ORDER BY ra_id LIMIT 1').get(console, norm) as { id: number; title: string } | undefined
  return r ?? null
}

interface RaAchievement { ID: number; Title: string; Description: string; Points: number; BadgeName: string; DateEarned?: string; DateEarnedHardcore?: string; DisplayOrder?: number }
interface RaProgress { Title?: string; Achievements?: Record<string, RaAchievement> | null }

/** Les dates de l'API sont en UTC, sans fuseau : « 2024-03-01 12:34:56 ». */
const parseDate = (s: string | undefined): number | null => {
  if (!s) return null
  const t = Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : null
}

export function parseProgress(raId: number, fallbackTitle: string, json: unknown, now = Date.now()): GameAchievements {
  const p = json as RaProgress
  const list: Achievement[] = Object.values(p.Achievements ?? {})
    .sort((a, b) => (a.DisplayOrder ?? 0) - (b.DisplayOrder ?? 0) || a.ID - b.ID)
    .map((a) => {
      const hard = parseDate(a.DateEarnedHardcore)
      const soft = parseDate(a.DateEarned)
      return { id: a.ID, title: a.Title, description: a.Description, points: a.Points, badge: a.BadgeName, earnedAt: hard ?? soft, hardcore: hard !== null }
    })
  const got = list.filter((a) => a.earnedAt !== null)
  return {
    raId, title: p.Title ?? fallbackTitle, total: list.length, earned: got.length,
    points: list.reduce((n, a) => n + a.points, 0), earnedPoints: got.reduce((n, a) => n + a.points, 0), achievements: list, fetchedAt: now
  }
}

export interface RaCreds { username: string; apiKey: string }

/** Succès d'un jeu de la bibliothèque : rapprochement par titre, puis progression de l'utilisateur (en cache 10 min). */
export async function getAchievements(
  db: DatabaseSync, entry: { id: number; console: string; title: string }, creds: RaCreds, opts: { refresh?: boolean; fetcher?: Fetcher; now?: number } = {}
): Promise<AchievementsResult> {
  const fetcher = opts.fetcher ?? defaultFetch
  const now = opts.now ?? Date.now()
  if (!RA_CONSOLES[entry.console]) return { status: 'unsupported' }
  if (!creds.username || !creds.apiKey) return { status: 'noKey' }
  try {
    const cached = db.prepare('SELECT json, fetched_at FROM ra_progress WHERE library_id = ?').get(entry.id) as { json: string; fetched_at: number } | undefined
    if (cached && !opts.refresh && now - cached.fetched_at < PROGRESS_TTL) return { status: 'ok', data: JSON.parse(cached.json) as GameAchievements }
    await syncGameList(db, entry.console, creds.apiKey, fetcher, now)
    const game = findGame(db, entry.console, entry.title)
    if (!game) return { status: 'noMatch' }
    const json = await fetcher(`${BASE}/API_GetGameInfoAndUserProgress.php?y=${encodeURIComponent(creds.apiKey)}&u=${encodeURIComponent(creds.username)}&g=${game.id}`)
    const data = parseProgress(game.id, game.title, json, now)
    if (data.total === 0) return { status: 'noMatch' }
    db.prepare('INSERT INTO ra_progress (library_id, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(library_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at').run(entry.id, JSON.stringify(data), now)
    return { status: 'ok', data }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    return { status: 'error', error: m === 'auth' ? 'auth' : m }
  }
}
