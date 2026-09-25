import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, migrate } from './migrations'
import { loadSettings, saveSettings } from './settingsStore'
import { DEFAULT_SETTINGS } from '@shared/settings'

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

describe('migrate', () => {
  it('applique toutes les migrations sur une base neuve', () => {
    const db = new DatabaseSync(':memory:')
    expect(migrate(db)).toBe(MIGRATIONS.length)
    expect(version(db)).toBe(MIGRATIONS.length)
  })

  it('est idempotent', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    migrate(db)
    expect(version(db)).toBe(MIGRATIONS.length)
  })

  it('reprend depuis la version courante', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, ['CREATE TABLE a (x)'])
    migrate(db, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)'])
    expect(version(db)).toBe(2)
    db.prepare('INSERT INTO b (y) VALUES (1)').run()
  })

  it('annule une migration qui échoue et garde la version précédente', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, ['CREATE TABLE a (x)'])
    expect(() => migrate(db, ['CREATE TABLE a (x)', 'CREATE TABLE c (z); INSERT INTO inexistante VALUES (1)'])).toThrow()
    expect(version(db)).toBe(1)
    expect(() => db.prepare('SELECT * FROM c').all()).toThrow()
  })

  it("refuse une base plus récente que l'app", () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA user_version = 99')
    expect(() => migrate(db)).toThrow(/newer/)
  })
})

describe('settingsStore', () => {
  const fresh = (): DatabaseSync => { const db = new DatabaseSync(':memory:'); migrate(db); return db }

  it('renvoie les valeurs par défaut sur une base vide', () => {
    expect(loadSettings(fresh())).toEqual(DEFAULT_SETTINGS)
  })

  it('persiste et relit', () => {
    const db = fresh()
    saveSettings(db, { language: 'fr', importDeleteSource: true })
    expect(loadSettings(db)).toMatchObject({ language: 'fr', importDeleteSource: true, importCopy: true })
  })

  it('ignore les valeurs invalides', () => {
    const db = fresh()
    saveSettings(db, { language: 'de' as never, importCopy: 'oui' as never })
    expect(loadSettings(db)).toEqual(DEFAULT_SETTINGS)
  })

  it('tolère une valeur JSON corrompue', () => {
    const db = fresh()
    db.prepare("INSERT INTO settings (key, value) VALUES ('language', '{oops')").run()
    expect(loadSettings(db).language).toBe('auto')
  })
})
