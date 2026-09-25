import type { DatabaseSync } from 'node:sqlite'

/** Migrations ordonnées ; l'index + 1 est la version de schéma (PRAGMA user_version). Ne jamais modifier une migration déjà livrée : en ajouter une. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // v2 : catalogue (DAT Libretro), état de synchro, quotas des fournisseurs, cache des fiches enrichies
  `CREATE TABLE catalog_games (
    id INTEGER PRIMARY KEY, console TEXT NOT NULL, title TEXT NOT NULL, region TEXT NOT NULL DEFAULT '',
    year INTEGER, genre TEXT, developer TEXT, crc TEXT, sha1 TEXT, size INTEGER, variant INTEGER NOT NULL DEFAULT 0,
    UNIQUE (console, title)
  );
  CREATE INDEX catalog_title ON catalog_games (title COLLATE NOCASE);
  CREATE INDEX catalog_crc ON catalog_games (crc);
  CREATE TABLE catalog_sync (console TEXT PRIMARY KEY, version TEXT, synced_at INTEGER NOT NULL, count INTEGER NOT NULL);
  CREATE TABLE provider_usage (provider TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (provider, day));
  CREATE TABLE game_meta (game_id INTEGER NOT NULL, provider TEXT NOT NULL, json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (game_id, provider))`,
  // v3 : score de popularité (IGDB) par jeu
  `ALTER TABLE catalog_games ADD COLUMN popularity REAL;
  CREATE INDEX catalog_popularity ON catalog_games (popularity)`
]

export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const current = row.user_version
  if (current > migrations.length) throw new Error(`Database schema v${current} is newer than this app (v${migrations.length})`)
  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(migrations[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return migrations.length
}
