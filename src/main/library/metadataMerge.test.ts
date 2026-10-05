import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { baseViewFrom, resolveView } from '@shared/overrides'
import type { CatalogGame } from '@shared/catalog'
import { getDetails, type MetadataProvider } from '../catalog/providers'
import { getGame } from '../catalog/catalogStore'
import { getOverrides, setOverride } from './overrides'

/*
 * Actualiser la fiche d'un jeu (fournisseurs IGDB, TheGamesDB, Wikipédia…) ne doit jamais remplacer un champ modifié par l'utilisateur ; les champs
 * qu'il n'a pas touchés sont, eux, mis à jour normalement. Les fournisseurs n'écrivent que dans le cache de fiches (`game_meta`) : la surcouche
 * (`library_overrides`) est une autre table, appliquée à l'affichage par `resolveView`.
 */

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
afterEach(() => db.close())

const gameId = (): number => Number(db.prepare("INSERT INTO catalog_games (console, title, name, base, dup) VALUES ('snes', 'Zelda (USA)', 'Zelda', 'zelda', 0)").run().lastInsertRowid)
const entryOf = (gid: number): number => Number(db.prepare("INSERT INTO library (game_id, console, title, path, size, match, added_at) VALUES (?, 'snes', 'Zelda', ?, 1, 'hash', 0)").run(gid, `p:${gid}`).lastInsertRowid)
const provider = (answer: () => Record<string, unknown>): MetadataProvider => ({ id: 'p', dailyLimit: 100, isConfigured: () => true, fetchDetails: async () => ({ provider: 'p', ...answer() }) as never })

describe('actualisation de la fiche d’un jeu modifié', () => {
  it('met à jour les champs non modifiés et conserve ceux de l’utilisateur', async () => {
    const gid = gameId()
    const entry = entryOf(gid)
    const game = getGame(db, gid) as CatalogGame
    let version = 1
    const p = provider(() => ({ summary: `Description v${version}`, developer: `Studio v${version}`, genres: [`Genre v${version}`], releaseYear: 1990 + version }))

    const first = await getDetails(db, game, [p], DEFAULT_SETTINGS)
    setOverride(db, entry, 'description', 'Ma description')
    setOverride(db, entry, 'developer', 'Mon studio')
    const view1 = resolveView(baseViewFrom(game, first, 'Zelda'), getOverrides(db, entry))
    expect(view1).toMatchObject({ description: 'Ma description', developer: 'Mon studio', genre: 'Genre v1', year: 1991 })

    version = 2
    const refreshed = await getDetails(db, game, [p], DEFAULT_SETTINGS, { refresh: true })
    expect(refreshed).toMatchObject({ summary: 'Description v2', developer: 'Studio v2' })
    const view2 = resolveView(baseViewFrom(game, refreshed, 'Zelda'), getOverrides(db, entry))
    expect(view2).toMatchObject({ description: 'Ma description', developer: 'Mon studio', genre: 'Genre v2', year: 1992 })
    expect(view2.overridden).toEqual(['description', 'developer'])
    expect(getOverrides(db, entry)).toEqual({ description: 'Ma description', developer: 'Mon studio' })
  })

  it('rétablir un champ le fait revenir à la valeur actualisée, pas à l’ancienne', async () => {
    const gid = gameId()
    const entry = entryOf(gid)
    const game = getGame(db, gid) as CatalogGame
    let summary = 'Ancienne'
    const p = provider(() => ({ summary }))
    await getDetails(db, game, [p], DEFAULT_SETTINGS)
    setOverride(db, entry, 'description', 'Ma description')
    summary = 'Nouvelle'
    const refreshed = await getDetails(db, game, [p], DEFAULT_SETTINGS, { refresh: true })
    setOverride(db, entry, 'description', '')
    expect(resolveView(baseViewFrom(game, refreshed, 'Zelda'), getOverrides(db, entry)).description).toBe('Nouvelle')
  })

  it('une fiche partagée par deux entrées ne mélange pas leurs surcharges', async () => {
    const gid = gameId()
    const a = entryOf(gid)
    const b = Number(db.prepare("INSERT INTO library (game_id, console, title, path, size, match, added_at) VALUES (?, 'snes', 'Zelda bis', 'p:b', 1, 'hash', 0)").run(gid).lastInsertRowid)
    setOverride(db, a, 'genre', 'RPG')
    const game = getGame(db, gid) as CatalogGame
    const details = await getDetails(db, game, [provider(() => ({ genres: ['Aventure'] }))], DEFAULT_SETTINGS)
    expect(resolveView(baseViewFrom(game, details, 'x'), getOverrides(db, a)).genre).toBe('RPG')
    expect(resolveView(baseViewFrom(game, details, 'x'), getOverrides(db, b)).genre).toBe('Aventure')
  })
})

describe('baseViewFrom', () => {
  it('suit l’ordre de la fiche : catalogue d’abord, fiche ensuite, titre de la bibliothèque à défaut', () => {
    expect(baseViewFrom({ name: 'Zelda', year: 1991, genre: 'Action', developer: 'Nintendo' }, { summary: 'S', developer: 'Autre', releaseYear: 1990, genres: ['RPG'] }, 'x'))
      .toEqual({ title: 'Zelda', description: 'S', genre: 'Action, rpg', year: 1991, developer: 'Nintendo' })
    expect(baseViewFrom({ name: 'Zelda', year: null, genre: null, developer: null }, { summary: 'S', developer: 'Dev', releaseYear: 1990, genres: ['RPG', 'Aventure'] }, 'x'))
      .toEqual({ title: 'Zelda', description: 'S', genre: 'rpg, Aventure', year: 1990, developer: 'Dev' })
    expect(baseViewFrom(null, null, 'Titre du fichier')).toEqual({ title: 'Titre du fichier', description: null, genre: null, year: null, developer: null })
  })
})
