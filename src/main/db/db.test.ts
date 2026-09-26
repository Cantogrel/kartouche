import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, migrate } from './migrations'
import { loadSettings, loadUserSettings, saveSettings } from './settingsStore'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { PROXY_KEY } from '@shared/proxy'

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
    expect(loadUserSettings(fresh())).toEqual(DEFAULT_SETTINGS)
  })

  it('persiste et relit', () => {
    const db = fresh()
    saveSettings(db, { language: 'fr', importDeleteSource: true })
    expect(loadSettings(db)).toMatchObject({ language: 'fr', importDeleteSource: true, importCopy: true })
  })

  it('ignore les valeurs invalides', () => {
    const db = fresh()
    saveSettings(db, { language: 'de' as never, importCopy: 'oui' as never })
    expect(loadUserSettings(db)).toEqual(DEFAULT_SETTINGS)
  })

  it('sans clé de catalogue saisie, passe par le proxy ; une clé saisie est gardée', () => {
    const db = fresh()
    expect(loadSettings(db)).toMatchObject({ igdbClientId: PROXY_KEY, igdbClientSecret: PROXY_KEY, tgdbApiKey: PROXY_KEY, sgdbApiKey: PROXY_KEY, raApiKey: '' })
    saveSettings(db, { tgdbApiKey: 'ma-cle' })
    expect(loadSettings(db).tgdbApiKey).toBe('ma-cle')
    expect(loadUserSettings(db).igdbClientId).toBe('')
  })

  it('tolère une valeur JSON corrompue', () => {
    const db = fresh()
    db.prepare("INSERT INTO settings (key, value) VALUES ('language', '{oops')").run()
    expect(loadSettings(db).language).toBe('auto')
  })
})
