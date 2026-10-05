import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS, migrate } from '../db/migrations'
import { deleteAllRomFiles, listLibrary, refreshMissing, relinkUnmatched, removeEntry } from './libraryStore'
import { getLaunchSpec, upsertExternalEntry } from './external'

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kext-')); db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const exeFile = (name = 'jeu.exe'): string => { const p = join(dir, name); writeFileSync(p, 'MZ'); return p }

describe('migration v20', () => {
  it('s’ajoute à une base v12 : les ROM existantes restent des ROM, sans source', () => {
    const old = new DatabaseSync(':memory:')
    migrate(old, MIGRATIONS.slice(0, 12))
    old.prepare("INSERT INTO library (console, title, path, size, match, added_at) VALUES ('snes', 'Zelda', 'p', 1, 'hash', 0)").run()
    expect(migrate(old)).toBe(MIGRATIONS.length)
    expect(old.prepare('SELECT console, kind, source, native_id, launch FROM library').all()).toEqual([{ console: 'snes', kind: 'rom', source: null, native_id: null, launch: null }])
    expect(() => old.prepare("INSERT INTO library (console, title, path, size, match, added_at, kind) VALUES ('pc', 'x', 'q', 0, 'none', 0, 'autre')").run()).toThrow()
    old.close()
  })
})

describe('upsertExternalEntry', () => {
  it('ajoute un exécutable manuel (console pc) et le retrouve au second ajout', () => {
    const exe = exeFile()
    const a = upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'Mon jeu', launch: { type: 'exe', exe } })
    expect(a).toMatchObject({ ok: true, created: true })
    const b = upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'Autre nom', launch: { type: 'exe', exe } })
    expect(b).toEqual({ ok: true, id: (a as { id: number }).id, created: false })
    const [e] = listLibrary(db)
    expect(e).toMatchObject({ console: 'pc', kind: 'exe', source: 'manual', title: 'Mon jeu', shownTitle: 'Mon jeu', path: exe, missing: false, gameId: null })
    expect(getLaunchSpec(db, e.id)).toEqual({ type: 'exe', exe })
  })

  it('un jeu de launcher est retrouvé par (source, identifiant natif) : lancement mis à jour, titre et temps de jeu conservés', () => {
    const first = upsertExternalEntry(db, { kind: 'launcher', source: 'steam', nativeId: '10', title: 'Half-Life', launch: { type: 'uri', uri: 'steam://rungameid/10', installDir: join(dir, 'hl') } })
    if (!first.ok) throw new Error('refusé')
    db.prepare('UPDATE library SET play_minutes = 42 WHERE id = ?').run(first.id)
    const again = upsertExternalEntry(db, { kind: 'launcher', source: 'steam', nativeId: '10', title: 'Half-Life (renommé)', launch: { type: 'uri', uri: 'steam://rungameid/10', exe: exeFile('hl.exe'), installDir: join(dir, 'hl2') } })
    expect(again).toEqual({ ok: true, id: first.id, created: false })
    expect(db.prepare('SELECT title, play_minutes FROM library WHERE id = ?').get(first.id)).toEqual({ title: 'Half-Life', play_minutes: 42 })
    expect(getLaunchSpec(db, first.id)).toMatchObject({ installDir: join(dir, 'hl2') })
    // même identifiant chez un autre launcher : autre jeu
    expect(upsertExternalEntry(db, { kind: 'launcher', source: 'gog', nativeId: '10', title: 'Autre', launch: { type: 'uri', uri: 'goggalaxy://openGameView/10' } })).toMatchObject({ ok: true, created: true })
    expect(listLibrary(db)).toHaveLength(2)
  })

  it('refuse une spécification invalide, un titre vide, un exe qui n’est pas lancé par exécutable, ou un chemin déjà pris par une ROM', () => {
    expect(upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'x', launch: { type: 'exe' } as never })).toEqual({ ok: false, reason: 'invalid' })
    expect(upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: '  ', launch: { type: 'exe', exe: 'a.exe' } })).toEqual({ ok: false, reason: 'invalid' })
    expect(upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'x', launch: { type: 'uri', uri: 'steam://1' } })).toEqual({ ok: false, reason: 'invalid' })
    db.prepare("INSERT INTO library (console, title, path, size, match, added_at) VALUES ('snes', 'Rom', ?, 1, 'hash', 0)").run('C:\\roms\\jeu.exe')
    expect(upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'x', launch: { type: 'exe', exe: 'C:\\roms\\jeu.exe' } })).toEqual({ ok: false, reason: 'pathTaken' })
    expect(listLibrary(db)).toHaveLength(1)
  })

  it('getLaunchSpec ne renvoie rien pour une ROM ou une entrée inconnue', () => {
    db.prepare("INSERT INTO library (console, title, path, size, match, added_at) VALUES ('snes', 'Rom', 'p', 1, 'hash', 0)").run()
    expect(getLaunchSpec(db, 1)).toBeNull()
    expect(getLaunchSpec(db, 99)).toBeNull()
  })
})

describe('présence du fichier', () => {
  it('« manquant » = l’exécutable ou le dossier d’installation a disparu ; sans rien à vérifier, l’entrée est supposée présente', () => {
    const exe = exeFile('present.exe')
    upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'Présent', launch: { type: 'exe', exe } })
    upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'Absent', launch: { type: 'exe', exe: join(dir, 'absent.exe') } })
    upsertExternalEntry(db, { kind: 'launcher', source: 'steam', nativeId: '1', title: 'Sans chemin', launch: { type: 'uri', uri: 'steam://rungameid/1' } })
    upsertExternalEntry(db, { kind: 'launcher', source: 'steam', nativeId: '2', title: 'Désinstallé', launch: { type: 'uri', uri: 'steam://rungameid/2', installDir: join(dir, 'parti') } })
    expect(refreshMissing(db)).toBe(2)
    const byTitle = Object.fromEntries(listLibrary(db).map((e) => [e.title, e.missing]))
    expect(byTitle).toEqual({ 'Présent': false, 'Absent': true, 'Sans chemin': false, 'Désinstallé': true })
  })
})

describe('sécurité : les fichiers d’une entrée non-ROM ne sont jamais supprimés', () => {
  const addExe = (): { id: number; exe: string } => {
    const exe = exeFile()
    const r = upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'Mon jeu', launch: { type: 'exe', exe } })
    if (!r.ok) throw new Error('refusé')
    return { id: r.id, exe }
  }

  it('removeEntry : file et save ne font rien, entry et all retirent l’entrée seule', async () => {
    const { id, exe } = addExe()
    await removeEntry(db, id, 'file', join(dir, 'saves'), join(dir, 'roms'), dir)
    await removeEntry(db, id, 'save', join(dir, 'saves'), join(dir, 'roms'), dir)
    expect(listLibrary(db)).toHaveLength(1)
    expect(existsSync(exe)).toBe(true)
    await removeEntry(db, id, 'all', join(dir, 'saves'), join(dir, 'roms'), dir)
    expect(listLibrary(db)).toHaveLength(0)
    expect(existsSync(exe)).toBe(true)
  })

  it('« Actions dangereuses » : supprimer tous les fichiers de ROM laisse les exécutables, vider la bibliothèque ne touche à aucun fichier', async () => {
    const { exe } = addExe()
    await deleteAllRomFiles(db, join(dir, 'roms'))
    expect(existsSync(exe)).toBe(true)
  })

  it('relinkUnmatched ignore les entrées non-ROM', () => {
    addExe()
    expect(relinkUnmatched(db)).toBe(0)
  })
})
