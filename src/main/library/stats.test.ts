import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, migrate } from '../db/migrations'
import { getStats, recordPlaySession } from './stats'

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
afterEach(() => db.close())

const DAY = 24 * 3600 * 1000
const NOW = Date.UTC(2026, 9, 5, 12)
const addEntry = (title: string, o: { minutes?: number; size?: number; addedAt?: number; lastPlayed?: number | null; gameId?: number | null } = {}): number =>
  Number(db.prepare("INSERT INTO library (game_id, console, title, path, size, match, added_at, play_minutes, last_played) VALUES (?, 'snes', ?, ?, ?, 'hash', ?, ?, ?)")
    .run(o.gameId ?? null, title, `p:${title}`, o.size ?? 0, o.addedAt ?? 0, o.minutes ?? 0, o.lastPlayed ?? null).lastInsertRowid)

describe('migration v21', () => {
  it('s’ajoute à une base v20 sans toucher aux jeux', () => {
    const old = new DatabaseSync(':memory:')
    migrate(old, MIGRATIONS.slice(0, 20))
    old.prepare("INSERT INTO library (console, title, path, size, match, added_at, play_minutes) VALUES ('snes', 'Zelda', 'p', 1, 'hash', 0, 90)").run()
    expect(migrate(old)).toBe(MIGRATIONS.length)
    expect(old.prepare('SELECT title, play_minutes FROM library').all()).toEqual([{ title: 'Zelda', play_minutes: 90 }])
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'play_sessions'").all()).toHaveLength(1)
    old.close()
  })
})

describe('getStats', () => {
  it('compte sessions, moyenne, plus longue, première partie et activité récente', () => {
    const id = addEntry('Zelda', { minutes: 300, lastPlayed: NOW - DAY, addedAt: NOW - 100 * DAY })
    recordPlaySession(db, id, NOW - 40 * DAY, NOW - 40 * DAY + 60 * 60_000, 60)
    recordPlaySession(db, id, NOW - 10 * DAY, NOW - 10 * DAY + 90 * 60_000, 90)
    recordPlaySession(db, id, NOW - 2 * DAY, NOW - 2 * DAY + 30 * 60_000, 30)
    const s = getStats(db, id, NOW)!
    expect(s).toMatchObject({ playMinutes: 300, sessions: 3, averageSessionMinutes: 60, longestSessionMinutes: 90, firstPlayed: NOW - 40 * DAY, lastPlayed: NOW - DAY, addedAt: NOW - 100 * DAY })
    expect(s.last7DaysMinutes).toBe(30)
    expect(s.last30DaysMinutes).toBe(120)
  })

  it('un jeu jamais lancé : tout à zéro, pas de rang', () => {
    const id = addEntry('Neuf')
    expect(getStats(db, id, NOW)).toMatchObject({ playMinutes: 0, sessions: 0, averageSessionMinutes: 0, longestSessionMinutes: 0, firstPlayed: null, lastPlayed: null, rank: null, playedGames: 0, last7DaysMinutes: 0 })
  })

  it('le temps total reste celui de la bibliothèque, même s’il dépasse la somme des sessions connues (temps d’avant la 0.3.0)', () => {
    const id = addEntry('Ancien', { minutes: 500 })
    recordPlaySession(db, id, NOW - DAY, NOW, 40)
    const s = getStats(db, id, NOW)!
    expect(s.playMinutes).toBe(500)
    expect(s.sessions).toBe(1)
    expect(s.averageSessionMinutes).toBe(40)
  })

  it('classe le jeu parmi ceux déjà lancés', () => {
    const a = addEntry('A', { minutes: 100 }); const b = addEntry('B', { minutes: 300 }); const c = addEntry('C', { minutes: 200 }); addEntry('Jamais')
    expect(getStats(db, b)).toMatchObject({ rank: 1, playedGames: 3 })
    expect(getStats(db, c)).toMatchObject({ rank: 2, playedGames: 3 })
    expect(getStats(db, a)).toMatchObject({ rank: 3, playedGames: 3 })
  })

  it('taille = ROM + mises à jour/DLC, popularité = celle du catalogue', () => {
    const gid = Number(db.prepare("INSERT INTO catalog_games (console, title, name, base, dup, popularity) VALUES ('snes', 'Z', 'Z', 'z', 0, 42)").run().lastInsertRowid)
    const id = addEntry('Z', { size: 1000, gameId: gid })
    db.prepare("INSERT INTO library_content (library_id, kind, title_id, label, path, size, added_at) VALUES (?, 'dlc', 'T1', 'DLC', 'q1', 300, 0)").run(id)
    db.prepare("INSERT INTO library_content (library_id, kind, title_id, label, path, size, added_at) VALUES (?, 'update', NULL, 'Maj', 'q2', 200, 0)").run(id)
    expect(getStats(db, id)).toMatchObject({ sizeBytes: 1500, popularity: 42 })
  })

  it('entrée inconnue : null ; session sur entrée inconnue : ignorée ; les sessions partent avec le jeu', () => {
    expect(getStats(db, 999)).toBeNull()
    recordPlaySession(db, 999, 0, 1, 5)
    expect(db.prepare('SELECT COUNT(*) AS n FROM play_sessions').get()).toEqual({ n: 0 })
    const id = addEntry('X')
    recordPlaySession(db, id, 10, 5, -3) // horloge qui recule, durée négative : bornées
    expect(db.prepare('SELECT started_at, ended_at, minutes FROM play_sessions').get()).toEqual({ started_at: 10, ended_at: 10, minutes: 0 })
    db.prepare('DELETE FROM library WHERE id = ?').run(id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM play_sessions').get()).toEqual({ n: 0 })
  })
})
