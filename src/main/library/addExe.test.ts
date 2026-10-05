import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import { exeTitleFromPath, isAddablePath, isExecutablePath } from '@shared/exeEntry'
import { listLibrary } from './libraryStore'
import { getLaunchSpec } from './external'
import { addExecutables, updateExeLaunch, type AddExeDeps } from './addExe'

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kexe-')); db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const file = (name: string): string => { const p = join(dir, name); writeFileSync(p, 'MZ'); return p }
// PNG minimal valide (1x1) pour l'icône simulée.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const deps = (over: Partial<AddExeDeps> = {}): AddExeDeps => ({ dataDir: dir, readShortcut: () => null, icon: async () => PNG, ...over })

describe('exeTitleFromPath', () => {
  it('propose un titre lisible', () => {
    expect(exeTitleFromPath('C:\\Jeux\\Mon_Super-Jeu.exe')).toBe('Mon Super Jeu')
    expect(exeTitleFromPath('D:/x/HollowKnight.exe')).toBe('Hollow Knight')
    expect(exeTitleFromPath('run.bat')).toBe('run')
  })
  it('reconnaît exécutables et raccourcis', () => {
    expect(isExecutablePath('a.EXE')).toBe(true)
    expect(isExecutablePath('a.lnk')).toBe(false)
    expect(isAddablePath('a.lnk')).toBe(true)
    expect(isAddablePath('a.sfc')).toBe(false)
  })
})

describe('addExecutables', () => {
  it('ajoute un exécutable avec titre déduit et icône personnelle, sans doublon', async () => {
    const exe = file('Mon_Jeu.exe')
    const r = await addExecutables(db, [exe], deps())
    expect(r.added).toHaveLength(1)
    const entry = listLibrary(db).find((e) => e.id === r.added[0])!
    expect(entry).toMatchObject({ title: 'Mon Jeu', kind: 'exe', source: 'manual', console: 'pc', missing: false })
    expect(entry.art.icon).toBeTruthy()
    const again = await addExecutables(db, [exe], deps())
    expect(again).toEqual({ added: [], existing: r.added, invalid: [] })
  })
  it('suit un raccourci jusqu’à sa cible, arguments et dossier compris', async () => {
    const exe = file('cible.exe'); const lnk = file('raccourci.lnk')
    const r = await addExecutables(db, [lnk], deps({ readShortcut: () => ({ target: exe, args: '-windowed', cwd: dir }) }))
    expect(getLaunchSpec(db, r.added[0])).toEqual({ type: 'exe', exe, args: '-windowed', cwd: dir })
  })
  it('refuse fichiers inconnus, introuvables et raccourcis sans cible', async () => {
    const r = await addExecutables(db, [file('notes.txt'), join(dir, 'absent.exe'), file('mort.lnk')], deps())
    expect(r.added).toEqual([]); expect(r.invalid).toHaveLength(3)
  })
  it('garde l’entrée même si l’icône est indisponible', async () => {
    const r = await addExecutables(db, [file('a.exe')], deps({ icon: async () => { throw new Error('non') } }))
    expect(r.added).toHaveLength(1)
  })
})

describe('updateExeLaunch', () => {
  it('modifie arguments et dossier, efface sur valeur vide, refuse un chemin déjà pris', async () => {
    const a = (await addExecutables(db, [file('a.exe')], deps({ icon: async () => null }))).added[0]
    const b = (await addExecutables(db, [file('b.exe')], deps({ icon: async () => null }))).added[0]
    expect(updateExeLaunch(db, a, { args: '-x 1', cwd: dir })).toBe(true)
    expect(getLaunchSpec(db, a)).toMatchObject({ args: '-x 1', cwd: dir })
    expect(updateExeLaunch(db, a, { args: '', cwd: '' })).toBe(true)
    expect(getLaunchSpec(db, a)?.args).toBeUndefined()
    expect(updateExeLaunch(db, a, { exe: join(dir, 'b.exe') })).toBe(false)
    expect(updateExeLaunch(db, a, { exe: 'x.txt' })).toBe(false)
    const moved = file('c.exe')
    expect(updateExeLaunch(db, b, { exe: moved })).toBe(true)
    expect(listLibrary(db).find((e) => e.id === b)?.path).toBe(moved)
  })
  it('ne touche pas une ROM', () => {
    const id = Number(db.prepare("INSERT INTO library (console, title, path, size, match, added_at) VALUES ('snes', 'Z', 'p', 1, 'hash', 0)").run().lastInsertRowid)
    expect(updateExeLaunch(db, id, { args: 'x' })).toBe(false)
  })
})
