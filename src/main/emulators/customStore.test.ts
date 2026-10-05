import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS, migrate } from '../db/migrations'
import { listEmulators } from './emulatorStore'
import { customEmulatorsForConsole, deleteCustomEmulator, getCustomEmulator, listCustomEmulators, saveCustomEmulator } from './customStore'

let dir: string
let db: DatabaseSync
let exe: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kemu-'))
  exe = join(dir, 'mon.exe'); writeFileSync(exe, 'MZ')
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const input = (o: Record<string, unknown> = {}) => ({ name: 'Mon émulateur', exe, args: '"{rom}"', consoles: ['snes'], extensions: ['sfc'], ...o })

describe('migration v22', () => {
  it('s’ajoute à une base v21 : les jeux existants gardent emulator_id NULL', () => {
    const old = new DatabaseSync(':memory:')
    migrate(old, MIGRATIONS.slice(0, 21))
    old.prepare("INSERT INTO library (console, title, path, size, match, added_at) VALUES ('snes', 'Zelda', 'p', 1, 'hash', 0)").run()
    expect(migrate(old)).toBe(MIGRATIONS.length)
    expect(old.prepare('SELECT emulator_id FROM library').all()).toEqual([{ emulator_id: null }])
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'custom_emulators'").all()).toHaveLength(1)
    old.close()
  })
})

describe('émulateurs personnalisés', () => {
  it('ajoute, relit, modifie et supprime', () => {
    const added = saveCustomEmulator(db, input())
    expect(added).toEqual({ ok: true, id: 'custom-1' })
    expect(saveCustomEmulator(db, input({ name: 'Autre' }))).toEqual({ ok: true, id: 'custom-2' })
    expect(getCustomEmulator(db, 'custom-1')).toEqual({ id: 'custom-1', name: 'Mon émulateur', exe, args: '"{rom}"', consoles: ['snes'], extensions: ['sfc'] })
    expect(saveCustomEmulator(db, input({ name: 'Renommé', consoles: ['snes', 'nes'] }), 'custom-1')).toEqual({ ok: true, id: 'custom-1' })
    expect(listCustomEmulators(db).map((e) => [e.id, e.name, e.missing])).toEqual([['custom-2', 'Autre', false], ['custom-1', 'Renommé', false]].sort((a, b) => (a[1] as string).localeCompare(b[1] as string)))
    deleteCustomEmulator(db, 'custom-2')
    expect(getCustomEmulator(db, 'custom-2')).toBeNull()
    expect(listCustomEmulators(db)).toHaveLength(1)
  })

  it('un identifiant supprimé n’est pas réutilisé tant qu’un plus grand existe', () => {
    saveCustomEmulator(db, input()); saveCustomEmulator(db, input({ name: 'B' }))
    deleteCustomEmulator(db, 'custom-1')
    expect(saveCustomEmulator(db, input({ name: 'C' }))).toEqual({ ok: true, id: 'custom-3' })
  })

  it('refuse une saisie invalide ou un exécutable absent, et une modification d’un identifiant inconnu, sans rien écrire', () => {
    expect(saveCustomEmulator(db, input({ name: '' }))).toEqual({ ok: false, error: 'name' })
    expect(saveCustomEmulator(db, input({ exe: join(dir, 'absent.exe') }))).toEqual({ ok: false, error: 'exe' })
    expect(saveCustomEmulator(db, input(), 'custom-9')).toEqual({ ok: false, error: 'notFound' })
    expect(listCustomEmulators(db)).toHaveLength(0)
  })

  it('signale un exécutable disparu sans supprimer l’émulateur', () => {
    saveCustomEmulator(db, input())
    rmSync(exe)
    expect(listCustomEmulators(db)[0]).toMatchObject({ id: 'custom-1', missing: true })
  })

  it('supprimer un émulateur remet à zéro le choix des jeux qui l’utilisaient, pas des autres', () => {
    saveCustomEmulator(db, input()); saveCustomEmulator(db, input({ name: 'B' }))
    const add = (title: string, emu: string | null): number => Number(db.prepare("INSERT INTO library (console, title, path, size, match, added_at, emulator_id) VALUES ('snes', ?, ?, 1, 'hash', 0, ?)").run(title, `p:${title}`, emu).lastInsertRowid)
    const a = add('A', 'custom-1'); const b = add('B', 'custom-2'); const c = add('C', 'retroarch')
    deleteCustomEmulator(db, 'custom-1')
    const choice = (id: number): unknown => (db.prepare('SELECT emulator_id FROM library WHERE id = ?').get(id) as { emulator_id: string | null }).emulator_id
    expect([choice(a), choice(b), choice(c)]).toEqual([null, 'custom-2', 'retroarch'])
  })

  it('liste ceux qui savent lancer une console', () => {
    saveCustomEmulator(db, input({ name: 'Snes' })); saveCustomEmulator(db, input({ name: 'Nes', consoles: ['nes'] }))
    expect(customEmulatorsForConsole(db, 'snes').map((e) => e.name)).toEqual(['Snes'])
    expect(customEmulatorsForConsole(db, 'gba')).toEqual([])
  })

  it('les émulateurs intégrés se comportent comme avant', () => {
    saveCustomEmulator(db, input())
    const builtIn = listEmulators(db)
    expect(builtIn.length).toBeGreaterThanOrEqual(11)
    expect(builtIn.every((e) => !e.id.startsWith('custom-'))).toBe(true)
    expect(builtIn.every((e) => e.installed === false)).toBe(true)
  })
})
