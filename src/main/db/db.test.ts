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

  // Bug réel (2026-09-29) : le v11 livré à l'utilisateur créait library_content.title_id en NOT NULL, corrigé plus
  // tard dans le code source — mais éditer le texte d'une migration déjà appliquée ne change rien à une base existante
  // (migrate() ne rejoue jamais un index déjà passé). Le vrai correctif est v12, qui reconstruit la table.
  it('v12 relâche library_content.title_id (NOT NULL dans le v11 déjà livré) sans perdre les lignes existantes', () => {
    const db = new DatabaseSync(':memory:')
    const oldV11 = `ALTER TABLE library ADD COLUMN title_id TEXT;
      CREATE INDEX library_title_id ON library (console, title_id);
      CREATE TABLE library_content (
        id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, title_id TEXT NOT NULL, version TEXT, label TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL, added_at INTEGER NOT NULL
      );
      CREATE INDEX library_content_lib ON library_content (library_id)`
    migrate(db, [...MIGRATIONS.slice(0, 10), oldV11]) // v1..v10 réels + l'ancien v11 (NOT NULL) : simule une base déjà migrée
    db.prepare("INSERT INTO library (id, console, title, path, size, match, added_at) VALUES (1, 'switch', 'Base', 'p', 1, 'none', 0)").run()
    db.prepare("INSERT INTO library_content (library_id, kind, title_id, label, path, size, added_at) VALUES (1, 'dlc', 'ABCD', 'DLC 1', 'q', 1, 0)").run()
    expect(() => db.prepare("INSERT INTO library_content (library_id, kind, title_id, label, path, size, added_at) VALUES (1, 'update', NULL, 'Update', 'r', 1, 0)").run()).toThrow()

    migrate(db, MIGRATIONS) // applique le vrai v12 (les index déjà passés, 0..10, sont ignorés par migrate())
    expect(version(db)).toBe(MIGRATIONS.length)
    db.prepare("INSERT INTO library_content (library_id, kind, title_id, label, path, size, added_at) VALUES (1, 'update', NULL, 'Update', 'r', 1, 0)").run()
    expect(db.prepare('SELECT title_id, label FROM library_content ORDER BY label').all()).toEqual([
      { title_id: 'ABCD', label: 'DLC 1' },
      { title_id: null, label: 'Update' }
    ])
  })

  it('v14 crée source_lists/sources sur une base déjà en v13', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, MIGRATIONS.slice(0, 13)) // v1..v13, comme une base déjà livrée avant la v0.2.0
    expect(version(db)).toBe(13)
    migrate(db, MIGRATIONS)
    expect(version(db)).toBe(MIGRATIONS.length)
    db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('Ma liste', 'https://example.org/list.json', 0)").run()
    const listId = (db.prepare('SELECT id FROM source_lists').get() as { id: number }).id
    db.prepare("INSERT INTO sources (list_id, console, title, uris) VALUES (?, 'snes', 'Super Mario World', '[\"https://example.org/smw.zip\"]')").run(listId)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n).toBe(1)
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
