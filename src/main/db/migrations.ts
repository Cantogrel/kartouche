import type { DatabaseSync } from 'node:sqlite'

/** Migrations ordonnées ; l'index + 1 est la version de schéma (PRAGMA user_version). Ne jamais modifier une migration déjà livrée : en ajouter une. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
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
