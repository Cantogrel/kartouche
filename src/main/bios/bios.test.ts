import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFirmwareUrl } from './official'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BIOS_SLOTS, matchBios } from '@shared/bios'
import { EMULATORS } from '@shared/emulators'
import type { AppPaths } from '@shared/ipc'
import { migrate } from '../db/migrations'
import { saveEmulator } from '../emulators/emulatorStore'
import { biosStatus, importBiosFile, readIniValue, removeBios, setTomlKeys } from './bios'

describe('bios : reconnaissance', () => {
  it('chaque emplacement appartient à un émulateur connu', () => {
    for (const s of BIOS_SLOTS) expect(EMULATORS.some((e) => e.id === s.emulator), s.id).toBe(true)
  })
  it('un BIOS PS1 de somme connue est vérifié, de somme inconnue accepté non vérifié', () => {
    const ok = matchBios('duckstation', { name: 'scph5501.bin', size: 512 * 1024, md5: '490f666e1afb15b7362b406ed1cea246' })
    expect(ok).toMatchObject({ verified: true, label: 'SCPH-5501 (USA)' })
    expect(matchBios('duckstation', { name: 'x.bin', size: 512 * 1024, md5: '0'.repeat(32) })?.verified).toBe(false)
  })
  it('refuse une mauvaise taille, un mauvais émulateur ou un mauvais nom', () => {
    expect(matchBios('duckstation', { name: 'a.bin', size: 1000 })).toBeNull()
    expect(matchBios('pcsx2', { name: 'a.bin', size: 512 * 1024 })).toBeNull()
    expect(matchBios('rpcs3', { name: 'autre.pup', size: 200 * 1048576 })).toBeNull()
    expect(matchBios('rpcs3', { name: 'PS3UPDAT.PUP', size: 200 * 1048576 })?.slot.id).toBe('ps3')
    expect(matchBios('pcsx2', { name: 'scph70012.bin', size: 4 * 1048576 })?.slot.id).toBe('ps2')
  })
})

describe('bios : melonDS.toml', () => {
  it('modifie une clé existante, ajoute les manquantes, crée la section si absente', () => {
    const a = setTomlKeys('[3D]\nRenderer = 1\n\n[DS]\nBIOS7Path = "old"\n\n[Other]\nx = 1\n', 'DS', { BIOS7Path: 'C:/b/bios7.bin', ExternalBIOSEnable: true })
    expect(a).toContain('BIOS7Path = "C:/b/bios7.bin"')
    expect(a.indexOf('ExternalBIOSEnable = true')).toBeLessThan(a.indexOf('[Other]'))
    expect(setTomlKeys('[3D]\nRenderer = 1\n', 'DS', { A: true })).toContain('[DS]\nA = true')
  })
})

describe('bios : import et détection', () => {
  let dir: string
  let paths: AppPaths
  let db: DatabaseSync
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rv-bios-'))
    paths = { dataDir: dir, roms: join(dir, 'roms'), emulators: join(dir, 'emulators'), bios: join(dir, 'bios'), saves: join(dir, 'saves'), cache: join(dir, 'cache'), dats: join(dir, 'dats'), logs: join(dir, 'logs') }
    db = new DatabaseSync(':memory:')
    migrate(db)
  })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

  it('place un BIOS PS2 dans le dossier de BIOS et le détecte', async () => {
    const src = join(dir, 'scph.bin')
    writeFileSync(src, Buffer.alloc(4 * 1048576))
    const before = await biosStatus({ db, paths })
    expect(before.find((s) => s.id === 'ps2')?.state).toBe('missing')
    const r = await importBiosFile({ db, paths }, 'pcsx2', src)
    expect(r).toMatchObject({ ok: true, slot: 'ps2' })
    expect(existsSync(join(paths.bios, 'pcsx2', 'scph.bin'))).toBe(true)
    expect((await biosStatus({ db, paths })).find((s) => s.id === 'ps2')?.state).toBe('ok')
  })
  it('signale un BIOS PS1 de somme inconnue comme non vérifié', async () => {
    mkdirSync(join(paths.bios, 'duckstation'), { recursive: true })
    writeFileSync(join(paths.bios, 'duckstation', 'x.bin'), Buffer.alloc(512 * 1024))
    expect((await biosStatus({ db, paths })).find((s) => s.id === 'ps1')).toMatchObject({ state: 'ok', unverified: true })
  })
  it('refuse un fichier inconnu, et une clé Switch tant qu’Eden n’est pas installé', async () => {
    const junk = join(dir, 'junk.txt')
    writeFileSync(junk, 'rien')
    expect(await importBiosFile({ db, paths }, 'pcsx2', junk)).toMatchObject({ ok: false, error: 'unknown' })
    const keys = join(dir, 'prod.keys')
    writeFileSync(keys, `header_key = ${'a'.repeat(32)}\nmaster_key_00 = ${'b'.repeat(32)}\n`)
    expect(await importBiosFile({ db, paths }, 'eden', keys)).toMatchObject({ ok: false, error: 'notInstalled' })
  })
  it('installe prod.keys dans le dossier d’Eden après validation du contenu', async () => {
    const emu = join(dir, 'emulators', 'eden')
    mkdirSync(emu, { recursive: true })
    saveEmulator(db, { id: 'eden', version: '1', dir: emu, exe: join(emu, 'eden.exe'), custom: false })
    const bad = join(dir, 'bad')
    mkdirSync(bad)
    writeFileSync(join(bad, 'prod.keys'), 'pas des clés')
    expect(await importBiosFile({ db, paths }, 'eden', join(bad, 'prod.keys'))).toMatchObject({ ok: false, error: 'unknown' })
    const keys = join(dir, 'prod.keys')
    writeFileSync(keys, `header_key = ${'a'.repeat(32)}\nmaster_key_00 = ${'b'.repeat(32)}\n`)
    expect(await importBiosFile({ db, paths }, 'eden', keys)).toMatchObject({ ok: true, slot: 'switch-keys' })
    expect(existsSync(join(emu, 'user', 'keys', 'prod.keys'))).toBe(true)
    expect((await biosStatus({ db, paths })).find((s) => s.id === 'switch-keys')?.state).toBe('ok')
  })

  it('Cemu : la clé d’exemple fournie par défaut ne compte pas comme présente, une vraie clé si', async () => {
    const emu = join(dir, 'emulators', 'cemu')
    mkdirSync(emu, { recursive: true })
    saveEmulator(db, { id: 'cemu', version: '1', dir: emu, exe: join(emu, 'Cemu.exe'), custom: false })
    writeFileSync(join(emu, 'keys.txt'), '# doc\n541b9889519b27d363cd21604b97c67a # example key (can be deleted)\n')
    expect((await biosStatus({ db, paths })).find((s) => s.id === 'wiiu-keys')?.state).toBe('missing')
    const key = 'a'.repeat(32)
    const src = join(dir, 'ma-cle.txt')
    writeFileSync(src, key)
    expect(await importBiosFile({ db, paths }, 'cemu', src)).toMatchObject({ ok: true, slot: 'wiiu-keys' })
    const text = readFileSync(join(emu, 'keys.txt'), 'utf8')
    expect(text).toContain('# example key')
    expect(text).toContain(key)
    expect((await biosStatus({ db, paths })).find((s) => s.id === 'wiiu-keys')?.state).toBe('ok')
  })

  it('Cemu : refuse un fichier sans clé valide', async () => {
    const emu = join(dir, 'emulators', 'cemu')
    mkdirSync(emu, { recursive: true })
    saveEmulator(db, { id: 'cemu', version: '1', dir: emu, exe: join(emu, 'Cemu.exe'), custom: false })
    const src = join(dir, 'rien.txt')
    writeFileSync(src, 'pas une clé')
    expect(await importBiosFile({ db, paths }, 'cemu', src)).toMatchObject({ ok: false, error: 'unknown' })
  })

  it('Azahar : les deux clés minimales sont requises, une seule ne suffit pas', async () => {
    const emu = join(dir, 'emulators', 'azahar')
    mkdirSync(emu, { recursive: true })
    saveEmulator(db, { id: 'azahar', version: '1', dir: emu, exe: join(emu, 'azahar.exe'), custom: false })
    const src1 = join(dir, 'cle1.txt')
    writeFileSync(src1, `slot0x25KeyX=${'c'.repeat(32)}\n`)
    expect(await importBiosFile({ db, paths }, 'azahar', src1)).toMatchObject({ ok: true, slot: '3ds-keys' })
    expect((await biosStatus({ db, paths })).find((s) => s.id === '3ds-keys')?.state).toBe('missing')
    const src2 = join(dir, 'cle2.txt')
    writeFileSync(src2, `slot0x2CKeyX=${'d'.repeat(32)}\n`)
    expect(await importBiosFile({ db, paths }, 'azahar', src2)).toMatchObject({ ok: true, slot: '3ds-keys' })
    expect((await biosStatus({ db, paths })).find((s) => s.id === '3ds-keys')?.state).toBe('ok')
    expect(existsSync(join(emu, 'user', 'sysdata', 'aes_keys.txt'))).toBe(true)
  })
})

describe('bios : configuré dans l’émulateur', () => {
  it('lit une clé INI et retrouve un BIOS PS2 rangé ailleurs, indiqué dans PCSX2.ini', async () => {
    expect(readIniValue('[BIOS]\nA = 1\n[Folders]\nBios = "x"\n', 'Folders', 'Bios')).toBe('x')
    const dir = mkdtempSync(join(tmpdir(), 'rv-bios2-'))
    try {
      const emu = join(dir, 'pcsx2')
      const other = join(dir, 'mes bios')
      mkdirSync(join(emu, 'inis'), { recursive: true })
      mkdirSync(other)
      writeFileSync(join(emu, 'inis', 'PCSX2.ini'), `[Folders]\nBios = ${other}\n`)
      writeFileSync(join(other, 'ps2.bin'), Buffer.alloc(4 * 1048576))
      const db = new DatabaseSync(':memory:')
      migrate(db)
      saveEmulator(db, { id: 'pcsx2', version: null, dir: emu, exe: join(emu, 'pcsx2-qt.exe'), custom: true })
      const paths = { dataDir: dir, roms: dir, emulators: dir, bios: join(dir, 'bios'), saves: dir, cache: dir, dats: dir, logs: dir }
      expect((await biosStatus({ db, paths })).find((s) => s.id === 'ps2')).toMatchObject({ state: 'ok', source: 'emulator' })
      db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('bios : sources officielles', () => {
  it('extrait l’adresse du firmware des listes de mise à jour', () => {
    const ps3 = '# US\nDest=84;ImageVersion=0004f1a0;SystemSoftwareVersion=4.9200;CDN=http://dus01.ps3.update.playstation.net/update/ps3/image/us/2025_0305_x/PS3UPDAT.PUP;CDN_Timeout=30\n'
    expect(parseFirmwareUrl('ps3', ps3)).toBe('http://dus01.ps3.update.playstation.net/update/ps3/image/us/2025_0305_x/PS3UPDAT.PUP')
    const vita = '<update_data update_type="full"><image size="1">https://dus01.psp2.update.playstation.net/update/psp2/image/2022_0209/rel_x/PSVUPDAT.PUP</image></update_data>'
    expect(parseFirmwareUrl('vita', vita)).toBe('https://dus01.psp2.update.playstation.net/update/psp2/image/2022_0209/rel_x/PSVUPDAT.PUP')
    expect(parseFirmwareUrl('vita', 'rien')).toBeNull()
    expect(parseFirmwareUrl('ps1', ps3)).toBeNull()
  })
})

describe('bios : retrait', () => {
  it('retire un BIOS installé par RomVault, mais pas celui rangé par l’utilisateur dans l’émulateur', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-bios3-'))
    try {
      const db = new DatabaseSync(':memory:')
      migrate(db)
      const paths = { dataDir: dir, roms: dir, emulators: dir, bios: join(dir, 'bios'), saves: dir, cache: dir, dats: dir, logs: dir }
      mkdirSync(join(paths.bios, 'pcsx2'), { recursive: true })
      const f = join(paths.bios, 'pcsx2', 'a.bin')
      writeFileSync(f, Buffer.alloc(4 * 1048576))
      expect(await removeBios({ db, paths }, 'ps2')).toBe(true)
      expect(existsSync(f)).toBe(false)
      expect(await removeBios({ db, paths }, 'ps2')).toBe(false)
      db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
