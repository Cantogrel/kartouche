import type { DatabaseSync } from 'node:sqlite'
import type { Collection } from '@shared/library'

export function listCollections(db: DatabaseSync): Collection[] {
  return db.prepare(
    `SELECT c.id, c.name, COUNT(i.library_id) AS count FROM collections c LEFT JOIN collection_items i ON i.collection_id = c.id
     GROUP BY c.id ORDER BY c.name COLLATE NOCASE`
  ).all() as unknown as Collection[]
}

/** Crée une collection (le nom est unique sans tenir compte de la casse) ; renvoie l'existante si le nom est déjà pris. Null si le nom est vide. */
export function createCollection(db: DatabaseSync, name: string): Collection | null {
  const n = name.trim().slice(0, 60)
  if (!n) return null
  const existing = db.prepare('SELECT id FROM collections WHERE name = ?').get(n) as { id: number } | undefined
  const id = existing?.id ?? Number(db.prepare('INSERT INTO collections (name, created_at) VALUES (?, ?)').run(n, Date.now()).lastInsertRowid)
  return listCollections(db).find((c) => c.id === id) ?? null
}

/** Renomme ; false si le nom est vide ou déjà pris par une autre collection. */
export function renameCollection(db: DatabaseSync, id: number, name: string): boolean {
  const n = name.trim().slice(0, 60)
  if (!n) return false
  const other = db.prepare('SELECT id FROM collections WHERE name = ? AND id <> ?').get(n, id)
  if (other) return false
  return Number(db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(n, id).changes) > 0
}

/** Supprime la collection (les jeux restent dans la bibliothèque). */
export function deleteCollection(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(id)
  db.prepare('DELETE FROM collections WHERE id = ?').run(id)
}

/** Ajoute ou retire un jeu d'une collection. */
export function setMembership(db: DatabaseSync, collectionId: number, entryId: number, member: boolean): void {
  if (member) db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, library_id) VALUES (?, ?)').run(collectionId, entryId)
  else db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND library_id = ?').run(collectionId, entryId)
}

/** Favori et/ou épingle d'un jeu (champ absent = inchangé). */
export function setFlags(db: DatabaseSync, entryId: number, flags: { favorite?: boolean; pinned?: boolean }): void {
  if (flags.favorite !== undefined) db.prepare('UPDATE library SET favorite = ? WHERE id = ?').run(flags.favorite ? 1 : 0, entryId)
  if (flags.pinned !== undefined) db.prepare('UPDATE library SET pinned = ? WHERE id = ?').run(flags.pinned ? 1 : 0, entryId)
}

/** Remplace d'un coup la liste des jeux d'une collection. */
export function setMembers(db: DatabaseSync, collectionId: number, entryIds: number[]): void {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(collectionId)
    const ins = db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, library_id) SELECT ?, id FROM library WHERE id = ?')
    for (const id of new Set(entryIds)) ins.run(collectionId, id)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}
