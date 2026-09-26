import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import { saveEmulator } from '../emulators/emulatorStore'
import { MAX_BACKUPS } from '@shared/saves'
import { backupSaves, deleteAllBackups, deleteBackup, deleteGameSaves, prepareRetroarch, readDiscId, restoreSaves, saveInfo } from './saves'

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-saves-')); db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const put = (...parts: string[]): string => {
  const f = join(dir, ...parts.slice(0, -1))
  mkdirSync(f, { recursive: true })
  const p = join(f, parts[parts.length - 1])
  writeFileSync(p, 'x')
  return p
}

describe('sauvegardes propres au jeu (RetroArch)', () => {
  const entry = { id: 5, console: 'nes', path: 'C:\\roms\\Super Game.nes' }
  it('ne voit que les fichiers du jeu, sauvegarde, restaure et supprime', async () => {
    const saves = join(dir, 'saves')
    put('saves', 'retroarch', 'saves', 'Super Game.srm'); put('saves', 'retroarch', 'states', 'Super Game.state1'); put('saves', 'retroarch', 'saves', 'Other.srm')
    expect(await saveInfo(db, saves, entry)).toMatchObject({ emulator: 'retroarch', scope: 'game', files: 2, backups: [] })
    const b = await backupSaves(db, saves, entry)
    expect(b?.name).toMatch(/^\d{8}-\d{6}\.zip$/)
    // Rien n'a changé : pas de nouvelle copie automatique.
    expect(await backupSaves(db, saves, entry, true)).toBeNull()
    writeFileSync(join(saves, 'retroarch', 'saves', 'Super Game.srm'), 'perdu')
    expect(await restoreSaves(db, saves, entry, b!.name)).toBe(true)
    expect(readFileSync(join(saves, 'retroarch', 'saves', 'Super Game.srm'), 'utf8')).toBe('x')
    expect((await saveInfo(db, saves, entry))!.backups.length).toBe(2) // + copie de sécurité avant la restauration
    await deleteGameSaves(db, saves, entry)
    expect(existsSync(join(saves, 'retroarch', 'saves', 'Super Game.srm'))).toBe(false)
    expect(existsSync(join(saves, 'retroarch', 'saves', 'Other.srm'))).toBe(true)
    await deleteBackup(db, saves, entry, b!.name)
    expect((await saveInfo(db, saves, entry))!.backups.length).toBe(1)
  })
  it('garde seulement les dernières copies et sait tout supprimer', async () => {
    const saves = join(dir, 'saves')
    put('saves', 'retroarch', 'saves', 'Super Game.srm')
    for (let i = 0; i < MAX_BACKUPS + 2; i++) await backupSaves(db, saves, entry)
    expect((await saveInfo(db, saves, entry))!.backups).toHaveLength(MAX_BACKUPS)
    expect(await deleteAllBackups(db, saves, entry)).toBe(MAX_BACKUPS)
    expect((await saveInfo(db, saves, entry))!.backups).toHaveLength(0)
  })
  it('refuse un nom de copie qui sort du dossier', async () => {
    expect(await restoreSaves(db, join(dir, 'saves'), entry, '..\\evil.zip')).toBe(false)
  })
})

describe('sauvegardes de l’émulateur entier (DuckStation)', () => {
  it('copie ses dossiers de cartes mémoire et d’états, ne supprime rien de partagé', async () => {
    const emu = join(dir, 'duck')
    put('duck', 'memcards', 'shared_card_1.mcd'); put('duck', 'savestates', 'SLES_1.sav')
    saveEmulator(db, { id: 'duckstation', version: '1', dir: emu, exe: join(emu, 'd.exe'), custom: false })
    const entry = { id: 1, console: 'ps1', path: 'x.cue' }
    const saves = join(dir, 'saves')
    expect(await saveInfo(db, saves, entry)).toMatchObject({ emulator: 'duckstation', scope: 'emulator', files: 2 })
    const b = await backupSaves(db, saves, entry)
    rmSync(join(emu, 'memcards'), { recursive: true })
    await restoreSaves(db, saves, entry, b!.name)
    expect(existsSync(join(emu, 'memcards', 'shared_card_1.mcd'))).toBe(true)
    await deleteGameSaves(db, saves, entry)
    expect(existsSync(join(emu, 'savestates', 'SLES_1.sav'))).toBe(true)
  })
  it('émulateur non installé : rien', async () => {
    expect(await saveInfo(db, join(dir, 'saves'), { id: 1, console: 'ps1', path: 'x.cue' })).toBeNull()
  })
})

describe('Dolphin : sauvegardes propres au jeu', () => {
  const disc = (name: string, at: number, id: string): string => {
    const p = join(dir, name)
    const b = Buffer.alloc(0x300)
    b.write(id, at, 'latin1')
    writeFileSync(p, b)
    return p
  }
  it('lit l’identifiant du disque selon le format', async () => {
    expect(await readDiscId(disc('a.rvz', 0x58, 'GZLP01'))).toBe('GZLP01')
    expect(await readDiscId(disc('a.iso', 0, 'GZLE01'))).toBe('GZLE01')
    expect(await readDiscId(disc('a.wbfs', 0x200, 'RSBP01'))).toBe('RSBP01')
    expect(await readDiscId(disc('a.gcz', 0, 'GZLP01'))).toBeNull()
    expect(await readDiscId(join(dir, 'absent.rvz'))).toBeNull()
  })
  it('ne retrouve et ne supprime que les fichiers du jeu (carte mémoire, Wii, états)', async () => {
    const emu = join(dir, 'dolphin')
    put('dolphin', 'User', 'GC', 'EUR', 'Card A', '01-GZLP-gczelda.gci'); put('dolphin', 'User', 'GC', 'EUR', 'Card A', '01-GXXP-autre.gci')
    put('dolphin', 'User', 'StateSaves', 'GZLP01.s01'); put('dolphin', 'User', 'StateSaves', 'GXXP01.s01')
    put('dolphin', 'User', 'Wii', 'title', '00010000', Buffer.from('RSBP').toString('hex'), 'data', 'save.bin')
    saveEmulator(db, { id: 'dolphin', version: '1', dir: emu, exe: join(emu, 'Dolphin.exe'), custom: false })
    const entry = { id: 3, console: 'gc', path: disc('Zelda.rvz', 0x58, 'GZLP01') }
    expect(await saveInfo(db, join(dir, 'saves'), entry)).toMatchObject({ emulator: 'dolphin', scope: 'game', files: 2 })
    const wii = { id: 4, console: 'wii', path: disc('Sports.rvz', 0x58, 'RSBP01') }
    expect(await saveInfo(db, join(dir, 'saves'), wii)).toMatchObject({ scope: 'game', files: 1 })
    const b = await backupSaves(db, join(dir, 'saves'), entry)
    await deleteGameSaves(db, join(dir, 'saves'), entry)
    expect(existsSync(join(emu, 'User', 'GC', 'EUR', 'Card A', '01-GZLP-gczelda.gci'))).toBe(false)
    expect(existsSync(join(emu, 'User', 'StateSaves', 'GZLP01.s01'))).toBe(false)
    expect(existsSync(join(emu, 'User', 'GC', 'EUR', 'Card A', '01-GXXP-autre.gci'))).toBe(true)
    expect(existsSync(join(emu, 'User', 'StateSaves', 'GXXP01.s01'))).toBe(true)
    await restoreSaves(db, join(dir, 'saves'), entry, b!.name)
    expect(existsSync(join(emu, 'User', 'GC', 'EUR', 'Card A', '01-GZLP-gczelda.gci'))).toBe(true)
    await deleteGameSaves(db, join(dir, 'saves'), wii)
    expect(existsSync(join(emu, 'User', 'Wii', 'title', '00010000', Buffer.from('RSBP').toString('hex')))).toBe(false)
  })
  it('format illisible : retombe sur l’émulateur entier', async () => {
    const emu = join(dir, 'dolphin')
    put('dolphin', 'User', 'GC', 'EUR', 'Card A', '01-GZLP-gczelda.gci')
    saveEmulator(db, { id: 'dolphin', version: '1', dir: emu, exe: join(emu, 'Dolphin.exe'), custom: false })
    expect(await saveInfo(db, join(dir, 'saves'), { id: 3, console: 'gc', path: disc('Z.gcz', 0, 'GZLP01') })).toMatchObject({ scope: 'emulator' })
  })
})

describe('RetroArch : dossiers de sauvegarde', () => {
  it('redirige la config et reprend les anciens fichiers', async () => {
    const ra = join(dir, 'ra')
    put('ra', 'saves', 'Old.srm')
    writeFileSync(join(ra, 'retroarch.cfg'), 'video_fullscreen = "true"\n')
    const saves = join(dir, 'data-saves')
    await prepareRetroarch(ra, saves)
    const cfg = readFileSync(join(ra, 'retroarch.cfg'), 'utf8')
    expect(cfg).toContain(`savefile_directory = "${join(saves, 'retroarch', 'saves')}"`)
    expect(cfg).toContain('video_fullscreen = "true"')
    expect(readdirSync(join(saves, 'retroarch', 'saves'))).toEqual(['Old.srm'])
    await prepareRetroarch(ra, saves) // idempotent
  })
})
