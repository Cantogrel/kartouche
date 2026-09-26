import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { findGame, getAchievements, normalizeTitle, parseProgress, syncGameList, type Fetcher } from './retroachievements'

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })

const LIST = [{ ID: 1, Title: 'Legend of Zelda, The: A Link to the Past' }, { ID: 2, Title: '~Hack~ Zelda Reloaded' }, { ID: 3, Title: 'Super Mario World' }]
const PROGRESS = {
  Title: 'Super Mario World',
  Achievements: {
    '10': { ID: 10, Title: 'B', Description: 'd2', Points: 10, BadgeName: '222', DisplayOrder: 2 },
    '9': { ID: 9, Title: 'A', Description: 'd1', Points: 5, BadgeName: '111', DisplayOrder: 1, DateEarned: '2024-03-01 12:00:00', DateEarnedHardcore: '2024-03-01 12:00:05' }
  }
}
const fakeFetch = (calls: string[]): Fetcher => async (url) => { calls.push(url); return url.includes('GetGameList') ? LIST : PROGRESS }
const entry = (title: string): number =>
  Number(db.prepare("INSERT INTO library (console, title, path, size, added_at) VALUES ('snes', ?, 'x', 1, 1)").run(title).lastInsertRowid)
const CREDS = { username: 'u', apiKey: 'k' }
const MARIO = { console: 'snes', title: 'Super Mario World' }

describe('normalizeTitle', () => {
  it('rapproche les écritures No-Intro et RetroAchievements', () => {
    expect(normalizeTitle('Legend of Zelda, The: A Link to the Past')).toBe(normalizeTitle('The Legend of Zelda - A Link to the Past (Europe)'))
    expect(normalizeTitle('Pokémon Rouge (France) [!]')).toBe('pokemonrouge')
    expect(normalizeTitle('Sonic & Knuckles')).toBe(normalizeTitle('Sonic and Knuckles'))
  })
})

describe('liste des jeux', () => {
  it('ignore les hacks (~…~), met en cache 30 jours et retrouve un jeu par titre', async () => {
    const calls: string[] = []
    await syncGameList(db, 'snes', 'KEY', fakeFetch(calls), 1000)
    await syncGameList(db, 'snes', 'KEY', fakeFetch(calls), 2000)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('i=3')
    expect(findGame(db, 'snes', 'The Legend of Zelda - A Link to the Past (USA)')).toMatchObject({ id: 1 })
    expect(findGame(db, 'snes', 'Zelda Reloaded')).toBeNull()
    expect(findGame(db, 'nes', 'Super Mario World')).toBeNull()
  })
})

describe('progression', () => {
  it('lit les succès triés, obtenus (dur ou non), points', () => {
    const g = parseProgress(3, 'x', PROGRESS, 5)
    expect(g).toMatchObject({ raId: 3, title: 'Super Mario World', total: 2, earned: 1, points: 15, earnedPoints: 5 })
    expect(g.achievements.map((a) => a.id)).toEqual([9, 10])
    expect(g.achievements[0]).toMatchObject({ hardcore: true, earnedAt: Date.parse('2024-03-01T12:00:05Z') })
    expect(g.achievements[1]).toMatchObject({ earnedAt: null, hardcore: false })
  })
  it('réponses selon les cas : sans clé, console non gérée, sans correspondance, cache, rafraîchissement', async () => {
    const id = entry('Super Mario World')
    const calls: string[] = []
    const f = fakeFetch(calls)
    expect(await getAchievements(db, { id, ...MARIO }, { username: '', apiKey: '' }, { fetcher: f })).toEqual({ status: 'noKey' })
    expect(await getAchievements(db, { id, console: 'switch', title: 'x' }, CREDS, { fetcher: f })).toEqual({ status: 'unsupported' })
    expect(await getAchievements(db, { id, console: 'snes', title: 'Inconnu' }, CREDS, { fetcher: f, now: 1 })).toEqual({ status: 'noMatch' })
    expect((await getAchievements(db, { id, ...MARIO }, CREDS, { fetcher: f, now: 10 })).status).toBe('ok')
    const n = calls.length
    await getAchievements(db, { id, ...MARIO }, CREDS, { fetcher: f, now: 20 })
    expect(calls).toHaveLength(n) // cache
    await getAchievements(db, { id, ...MARIO }, CREDS, { fetcher: f, now: 30, refresh: true })
    expect(calls).toHaveLength(n + 1)
  })
  it('signale une erreur d’authentification', async () => {
    const id = entry('Super Mario World')
    const bad: Fetcher = async () => { throw new Error('auth') }
    expect(await getAchievements(db, { id, ...MARIO }, CREDS, { fetcher: bad })).toEqual({ status: 'error', error: 'auth' })
  })
})
