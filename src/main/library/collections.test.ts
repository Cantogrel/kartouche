import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { createCollection, deleteCollection, listCollections, renameCollection, setFlags, setMembers, setMembership } from './collections'
import { listLibrary } from './libraryStore'

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
const addEntry = (title: string): number =>
  Number(db.prepare("INSERT INTO library (console, title, path, size, added_at) VALUES ('nes', ?, ?, 1, 1)").run(title, `C:\\r\\${title}.nes`).lastInsertRowid)

describe('favoris et épingles', () => {
  it('bascule chaque indicateur sans toucher à l’autre', () => {
    const id = addEntry('A')
    expect(listLibrary(db)[0]).toMatchObject({ favorite: false, pinned: false, collections: [] })
    setFlags(db, id, { favorite: true })
    expect(listLibrary(db)[0]).toMatchObject({ favorite: true, pinned: false })
    setFlags(db, id, { pinned: true })
    expect(listLibrary(db)[0]).toMatchObject({ favorite: true, pinned: true })
    setFlags(db, id, { favorite: false })
    expect(listLibrary(db)[0]).toMatchObject({ favorite: false, pinned: true })
  })
})

describe('collections', () => {
  it('crée sans doublon (casse ignorée), refuse un nom vide, compte les jeux', () => {
    const a = createCollection(db, 'RPG')!
    expect(createCollection(db, '  rpg ')!.id).toBe(a.id)
    expect(createCollection(db, '   ')).toBeNull()
    const g = addEntry('A'), h = addEntry('B')
    setMembership(db, a.id, g, true); setMembership(db, a.id, g, true); setMembership(db, a.id, h, true)
    expect(listCollections(db)).toEqual([{ id: a.id, name: 'RPG', count: 2 }])
    expect(listLibrary(db).find((e) => e.id === g)!.collections).toEqual([a.id])
    setMembership(db, a.id, h, false)
    expect(listCollections(db)[0].count).toBe(1)
  })
  it('renomme (refuse un nom pris) et supprime sans toucher aux jeux', () => {
    const a = createCollection(db, 'A')!, b = createCollection(db, 'B')!
    expect(renameCollection(db, b.id, 'a')).toBe(false)
    expect(renameCollection(db, b.id, 'C')).toBe(true)
    setMembership(db, a.id, addEntry('X'), true)
    deleteCollection(db, a.id)
    expect(listCollections(db).map((c) => c.name)).toEqual(['C'])
    expect(listLibrary(db)).toHaveLength(1)
    expect(listLibrary(db)[0].collections).toEqual([])
  })
  it('retirer un jeu de la bibliothèque le retire de ses collections', () => {
    const c = createCollection(db, 'A')!, id = addEntry('X')
    setMembership(db, c.id, id, true)
    db.prepare('DELETE FROM library WHERE id = ?').run(id)
    expect(listCollections(db)[0].count).toBe(0)
  })
  it('remplace la liste des jeux d’un coup (ids inconnus ignorés)', () => {
    const c = createCollection(db, 'A')!, x = addEntry('X'), y = addEntry('Y'), z = addEntry('Z')
    setMembership(db, c.id, x, true)
    setMembers(db, c.id, [y, z, z, 999])
    expect(listLibrary(db).filter((e) => e.collections.includes(c.id)).map((e) => e.title)).toEqual(['Y', 'Z'])
    setMembers(db, c.id, [])
    expect(listCollections(db)[0].count).toBe(0)
  })
})
