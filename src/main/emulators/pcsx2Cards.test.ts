import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isGameSave, migrateSharedSaves, pcsx2CardNames, pcsx2SerialFromLog, preparePcsx2Cards, readPs2Card } from './pcsx2Cards'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-p2c-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/**
 * Carte mémoire PS2 de 8 Mo construite d'après la structure de PCSX2 (MemoryCardFolder.h) : superbloc (page 0), cluster d'indirection de FAT, FAT, puis les
 * clusters de données (répertoire racine, répertoires de sauvegardes, fichiers). `ecc` : pages de 528 octets (fichiers .ps2 de PCSX2) ou de 512.
 */
export function makeCard(saves: Record<string, Record<string, string>>, ecc = true): Buffer {
  const page = ecc ? 528 : 512
  const card = Buffer.alloc(16384 * page, 0xff)
  const allocOffset = 41
  const ifcCluster = 8, fatCluster = 9
  const write = (cluster: number, data: Buffer): void => {
    for (let i = 0; i < 2; i++) {
      const chunk = Buffer.alloc(512)
      if (data.length > i * 512) data.copy(chunk, 0, i * 512, Math.min(data.length, (i + 1) * 512))
      chunk.copy(card, (cluster * 2 + i) * page)
    }
  }
  const sb = Buffer.alloc(512)
  sb.write('Sony PS2 Memory Card Format 1.2.0.0', 0, 'latin1')
  sb.writeUInt16LE(512, 0x28); sb.writeUInt16LE(2, 0x2a); sb.writeUInt16LE(16, 0x2c); sb.writeUInt32LE(8192, 0x30)
  sb.writeUInt32LE(allocOffset, 0x34); sb.writeUInt32LE(8000, 0x38); sb.writeUInt32LE(0, 0x3c); sb.writeUInt32LE(ifcCluster, 0x50)
  card.fill(0, 0, 512); sb.copy(card, 0)
  const ind = Buffer.alloc(1024, 0xff); ind.writeUInt32LE(fatCluster, 0)
  write(ifcCluster, ind)
  const fat: number[] = new Array<number>(256).fill(0x7fffffff)
  let next = 0
  const alloc = (bytes: number): number => {
    const n = Math.max(1, Math.ceil(bytes / 1024))
    const start = next
    for (let i = 0; i < n; i++, next++) fat[next] = i === n - 1 ? 0xffffffff : (0x80000000 | (next + 1)) >>> 0
    return start
  }
  const entry = (mode: number, length: number, cluster: number, name: string): Buffer => {
    const e = Buffer.alloc(512)
    e.writeUInt32LE(mode, 0); e.writeUInt32LE(length, 4); e.writeUInt32LE(cluster, 16); e.write(name, 64, 'latin1')
    return e
  }
  const DIR = 0x8427, FILE = 0x8497
  const writeDir = (start: number, entries: Buffer[]): void => {
    const raw = Buffer.concat(entries)
    for (let i = 0; i * 1024 < raw.length; i++) write(allocOffset + start + i, raw.subarray(i * 1024, (i + 1) * 1024))
  }
  const rootEntries = 2 + Object.keys(saves).length
  const rootStart = alloc(rootEntries * 512)
  const rootList: Buffer[] = [entry(DIR, rootEntries, 0, '.'), entry(DIR, 2, 0, '..')]
  for (const [name, files] of Object.entries(saves)) {
    const fileNames = Object.keys(files)
    const dirStart = alloc((fileNames.length + 2) * 512)
    const list: Buffer[] = [entry(DIR, fileNames.length + 2, 0, '.'), entry(DIR, 2, 0, '..')]
    for (const f of fileNames) {
      const data = Buffer.from(files[f], 'latin1')
      const start = alloc(Math.max(1, data.length))
      for (let i = 0; i * 1024 < Math.max(1, data.length); i++) write(allocOffset + start + i, data.subarray(i * 1024, (i + 1) * 1024))
      list.push(entry(FILE, data.length, start, f))
    }
    writeDir(dirStart, list)
    rootList.push(entry(DIR, fileNames.length + 2, dirStart, name))
  }
  writeDir(rootStart, rootList)
  const fatBuf = Buffer.alloc(1024)
  fat.forEach((v, i) => fatBuf.writeUInt32LE(v >>> 0, i * 4))
  write(fatCluster, fatBuf)
  return card
}

describe('readPs2Card', () => {
  it('lit les sauvegardes d\'une carte (pages de 528 octets, fichiers de plusieurs clusters compris)', () => {
    const big = 'x'.repeat(3000)
    const saves = readPs2Card(makeCard({ 'BESLES-52541GTASAV': { 'icon.sys': 'ICON', data: big }, 'BASLUS-21050SAVE': { 'save.bin': 'ABC' } }))
    expect(saves.map((s) => s.name)).toEqual(['BESLES-52541GTASAV', 'BASLUS-21050SAVE'])
    expect(saves[0].files.map((f) => f.name)).toEqual(['icon.sys', 'data'])
    expect(saves[0].files[1].data.toString('latin1')).toBe(big)
    expect(saves[1].files[0].data.toString('latin1')).toBe('ABC')
  })
  it('lit aussi une carte sans ECC (pages de 512 octets)', () => {
    expect(readPs2Card(makeCard({ 'BESLES-52541A': { f: 'z' } }, false)).map((s) => s.name)).toEqual(['BESLES-52541A'])
  })
  it('carte non formatée ou autre fichier : aucune sauvegarde', () => {
    expect(readPs2Card(Buffer.alloc(16384 * 528, 0xff))).toEqual([])
    expect(readPs2Card(Buffer.from('abc'))).toEqual([])
  })
  it('reconnaît le dossier d\'un jeu à son numéro de série (B + région + série), pas celui d\'un autre', () => {
    expect(isGameSave('BESLES-52541GTASAV', 'SLES-52541')).toBe(true)
    expect(isGameSave('BASLUS-21050SAVE', 'SLES-52541')).toBe(false)
    expect(isGameSave('SLES-52541', 'SLES-52541')).toBe(false)
    expect(isGameSave('BESLES-525419', 'SLES-52541')).toBe(true)
  })
})

describe('migrateSharedSaves', () => {
  it('copie seulement les sauvegardes du jeu dans sa carte, une fois, sans toucher aux cartes partagées', async () => {
    const memcards = join(dir, 'memcards'); mkdirSync(memcards)
    const card = makeCard({ 'BESLES-52541GTASAV': { 'a.bin': 'GTA' }, 'BASLUS-21050SAVE': { 'b.bin': 'AUTRE' } })
    writeFileSync(join(memcards, 'Mcd001.ps2'), card)
    const target = join(memcards, 'RomVault-SLES-52541'); mkdirSync(target)
    expect(await migrateSharedSaves(memcards, 'SLES-52541', target, 'Mcd001.ps2')).toBe(1)
    expect(readFileSync(join(target, 'BESLES-52541GTASAV', 'a.bin'), 'latin1')).toBe('GTA')
    expect(existsSync(join(target, 'BASLUS-21050SAVE'))).toBe(false)
    expect(readFileSync(join(memcards, 'Mcd001.ps2')).equals(card)).toBe(true)
    // Une seconde fois : le marqueur empêche de recopier (l'utilisateur a pu supprimer la sauvegarde depuis).
    rmSync(join(target, 'BESLES-52541GTASAV'), { recursive: true })
    expect(await migrateSharedSaves(memcards, 'SLES-52541', target, 'Mcd001.ps2')).toBe(0)
    expect(existsSync(join(target, 'BESLES-52541GTASAV'))).toBe(false)
  })
  it('n\'écrase jamais une sauvegarde déjà présente dans la carte du jeu', async () => {
    const memcards = join(dir, 'memcards'); mkdirSync(memcards)
    writeFileSync(join(memcards, 'Mcd001.ps2'), makeCard({ 'BESLES-52541GTASAV': { 'a.bin': 'ANCIENNE' } }))
    const target = join(memcards, 'c'); mkdirSync(join(target, 'BESLES-52541GTASAV'), { recursive: true })
    writeFileSync(join(target, 'BESLES-52541GTASAV', 'a.bin'), 'RECENTE')
    expect(await migrateSharedSaves(memcards, 'SLES-52541', target, 'Mcd001.ps2')).toBe(0)
    expect(readFileSync(join(target, 'BESLES-52541GTASAV', 'a.bin'), 'utf8')).toBe('RECENTE')
  })
})

describe('preparePcsx2Cards', () => {
  const game = { serial: 'SLES-52541', crc: 'B440A8FE' }
  const ini = (): string => readFileSync(join(dir, 'gamesettings', 'SLES-52541_B440A8FE.ini'), 'utf8')
  it('crée deux cartes dossier dédiées et les déclare dans les réglages du jeu', async () => {
    const r = await preparePcsx2Cards(dir, game, 'SLES-52541', 4)
    expect(r.args).toEqual([])
    const [a, b] = pcsx2CardNames('SLES-52541')
    expect(existsSync(join(dir, 'memcards', a, '_pcsx2_superblock'))).toBe(true)
    expect(existsSync(join(dir, 'memcards', b, '_pcsx2_superblock'))).toBe(true)
    expect(ini()).toContain(`Slot1_Filename = ${a}`)
    expect(ini()).toContain(`Slot2_Filename = ${b}`)
  })
  it('deux jeux : deux cartes distinctes', async () => {
    await preparePcsx2Cards(dir, game, 'SLES-52541', 4)
    await preparePcsx2Cards(dir, { serial: 'SLUS-21050', crc: '11111111' }, 'SLUS-21050', 5)
    expect(readdirSync(join(dir, 'memcards')).filter((n) => !n.endsWith('.romvault-migrated')).sort()).toEqual(['RomVault-SLES-52541', 'RomVault-SLES-52541-2', 'RomVault-SLUS-21050', 'RomVault-SLUS-21050-2'])
  })
  it('complète les réglages existants sans toucher à ce que l\'utilisateur y a mis, carte comprise', async () => {
    mkdirSync(join(dir, 'gamesettings'))
    writeFileSync(join(dir, 'gamesettings', 'SLES-52541_B440A8FE.ini'), '[EmuCore/GS]\nupscale_multiplier = 3\n\n[MemoryCards]\nSlot1_Filename = MaCarte.ps2\n')
    await preparePcsx2Cards(dir, game, 'SLES-52541', 4)
    expect(ini()).toContain('upscale_multiplier = 3')
    expect(ini()).toContain('Slot1_Filename = MaCarte.ps2')
    expect(ini()).toContain('Slot2_Filename = RomVault-SLES-52541-2')
  })
  it('sans CRC (disque illisible) : réglages à nous donnés par -gamecfg ; carte nommée d\'après le jeu', async () => {
    const r = await preparePcsx2Cards(dir, null, 'SLES-52541', 9)
    expect(r.args[0]).toBe('-gamecfg')
    expect(readFileSync(r.args[1], 'utf8')).toContain('Slot1_Filename = RomVault-SLES-52541')
  })
  it('sans identifiant du tout : carte propre à l\'entrée, rebaptisée dès que le numéro de série est connu', async () => {
    const first = await preparePcsx2Cards(dir, null, null, 9)
    expect(first.names[0]).toBe('RomVault-g9')
    writeFileSync(join(dir, 'memcards', 'RomVault-g9', 'sauvegarde'), 'x')
    await preparePcsx2Cards(dir, game, 'SLES-52541', 9)
    expect(existsSync(join(dir, 'memcards', 'RomVault-g9'))).toBe(false)
    expect(readFileSync(join(dir, 'memcards', 'RomVault-SLES-52541', 'sauvegarde'), 'utf8')).toBe('x')
  })
  it('reprend les sauvegardes que le jeu avait dans la carte partagée', async () => {
    mkdirSync(join(dir, 'memcards'))
    writeFileSync(join(dir, 'memcards', 'Mcd001.ps2'), makeCard({ 'BESLES-52541GTASAV': { 'a.bin': 'GTA' } }))
    const r = await preparePcsx2Cards(dir, game, 'SLES-52541', 4)
    expect(r.migrated).toBe(1)
    expect(existsSync(join(dir, 'memcards', 'RomVault-SLES-52541', 'BESLES-52541GTASAV', 'a.bin'))).toBe(true)
  })
  it('lit le numéro de série dans le journal de PCSX2', async () => {
    mkdirSync(join(dir, 'logs'))
    writeFileSync(join(dir, 'logs', 'emulog.txt'), '[ 0,6109]   Serial: SLES-52541\n[ 0,6109]   CRC: B440A8FE\n')
    expect(await pcsx2SerialFromLog(dir)).toBe('SLES-52541')
  })
})
