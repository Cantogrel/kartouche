import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'
import { migrate } from '../db/migrations'
import { hashFile, readZip } from './hash'
import { identify } from './identify'
import { importPaths } from './importer'
import { listLibrary } from './libraryStore'

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-')); db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const addGame = (console: string, title: string, base: string, crc: string | null, size: number | null, dup = 0): number =>
  Number(db.prepare('INSERT INTO catalog_games (console, title, name, crc, size, base, dup) VALUES (?, ?, ?, ?, ?, ?, ?)').run(console, title, title, crc, size, base, dup).lastInsertRowid)

/** Zip minimal (une entrée compressée) pour tester la lecture du répertoire central. */
function makeZip(name: string, data: Buffer): Buffer {
  const comp = deflateRawSync(data), nm = Buffer.from(name), crc = crc32(data)
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26)
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10)
  cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28)
  const off = lh.length + nm.length + comp.length
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(cd.length + nm.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([lh, nm, comp, cd, nm, end])
}

describe('hash', () => {
  it('calcule CRC32 et SHA1 (« 123456789 » → cbf43926)', async () => {
    const f = join(dir, 'a.bin'); writeFileSync(f, '123456789')
    const h = await hashFile(f)
    expect(h.crc).toBe('cbf43926'); expect(h.size).toBe(9); expect(h.sha1).toBe('f7c3bc1d808e04732adf679965ccc34ca7ae3441')
  })
  it('lit le CRC et la taille dans un zip sans décompresser', async () => {
    const data = Buffer.from('hello rom'); const f = join(dir, 'a.zip'); writeFileSync(f, makeZip('Game.nes', data))
    expect(await readZip(f)).toEqual([{ name: 'Game.nes', crc: hex(crc32(data)), size: data.length }])
  })
  it('renvoie null pour un fichier qui n’est pas un zip', async () => {
    const f = join(dir, 'x.zip'); writeFileSync(f, 'pas un zip'); expect(await readZip(f)).toBeNull()
  })
})

describe('identify', () => {
  it('reconnaît par CRC + taille et ramène une version dupliquée à l’entrée représentative', () => {
    const rep = addGame('nes', 'Zelda (Europe)', 'zelda', 'aaaaaaaa', 10)
    addGame('nes', 'Zelda (USA)', 'zelda', 'bbbbbbbb', 10, 1)
    const r = identify(db, { name: 'x', ext: 'nes', crc: 'BBBBBBBB', size: 10 })
    expect(r).toMatchObject({ gameId: rep, console: 'nes', match: 'hash' })
    expect(identify(db, { name: 'x', ext: 'nes', crc: 'bbbbbbbb', size: 11 }).gameId).toBeNull()
    const up = addGame('gba', 'Maj', 'maj', '9D4F1E18', 3)
    expect(identify(db, { name: 'x', ext: 'gba', crc: '9d4f1e18', size: 3 }).gameId).toBe(up) // DAT en majuscules
  })
  it('l’extension tranche une collision de CRC entre consoles', () => {
    addGame('gb', 'Jeu', 'jeu', 'cccccccc', 5); const gbc = addGame('gbc', 'Jeu', 'jeu', 'cccccccc', 5)
    expect(identify(db, { name: 'x', ext: 'gbc', crc: 'cccccccc', size: 5 }).gameId).toBe(gbc)
  })
  it('retombe sur le nom quand aucune empreinte ne correspond (Switch)', () => {
    const id = addGame('switch', 'Mario Kart 8 Deluxe', 'mariokart8deluxe', null, null)
    expect(identify(db, { name: 'Mario Kart 8 Deluxe [0100152000022000][v0]', ext: 'nsp' }).gameId).toBe(id) // les crochets du dump sont ignorés
    expect(identify(db, { name: 'Mario Kart 8 Deluxe (Europe)', ext: 'nsp' })).toMatchObject({ gameId: id, match: 'name' })
  })
  it('signale l’ambiguïté d’un .iso inconnu et devine la console d’une extension unique', () => {
    expect(identify(db, { name: 'inconnu', ext: 'iso' })).toMatchObject({ gameId: null, console: null })
    expect(identify(db, { name: 'inconnu', ext: 'gba' })).toMatchObject({ gameId: null, console: 'gba', match: 'none' })
  })
})

describe('import', () => {
  const opt = () => ({ copy: true, deleteSource: false, romsDir: join(dir, 'roms') })
  const rom = (name: string, content: string): string => { const f = join(dir, 'src', name); mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(f, content); return f }

  it('identifie, copie dans roms/<console> et enregistre ; un second import est un doublon', async () => {
    const f = rom('Test.nes', '123456789')
    const id = addGame('nes', 'Test (Europe)', 'test', 'cbf43926', 9)
    const r = await importPaths(db, [f], opt())
    expect(r.items[0]).toMatchObject({ status: 'added', console: 'nes', match: 'hash' })
    expect(existsSync(join(dir, 'roms', 'nes', 'Test.nes'))).toBe(true); expect(existsSync(f)).toBe(true)
    expect(listLibrary(db)[0]).toMatchObject({ gameId: id, console: 'nes', missing: false })
    expect((await importPaths(db, [f], opt())).items[0].status).toBe('duplicate')
  })
  it('supprime l’original après copie vérifiée si demandé', async () => {
    const f = rom('Test.nes', '123456789'); addGame('nes', 'Test', 'test', 'cbf43926', 9)
    await importPaths(db, [f], { ...opt(), deleteSource: true })
    expect(existsSync(f)).toBe(false); expect(readdirSync(join(dir, 'roms', 'nes'))).toEqual(['Test.nes'])
  })
  it('sans copie, référence le fichier en place ; parcourt un dossier et ignore le reste', async () => {
    rom('a.gba', 'aaa'); rom('b.gba', 'bbb'); rom('notes.txt', 'x')
    const r = await importPaths(db, [join(dir, 'src')], { ...opt(), copy: false })
    expect(r.items.filter((i) => i.status === 'added')).toHaveLength(2); expect(r.ignored).toBe(1)
    expect(existsSync(join(dir, 'roms'))).toBe(false)
  })
  it('lit un zip d’une ROM et signale un .iso ambigu sans l’importer', async () => {
    const data = Buffer.from('zip rom'); const z = join(dir, 'Zip.sfc.zip'); writeFileSync(z, makeZip('Zip.sfc', data))
    addGame('snes', 'Zip', 'zip', hex(crc32(data)), data.length)
    expect((await importPaths(db, [z], opt())).items[0]).toMatchObject({ status: 'added', console: 'snes', match: 'hash' })
    expect((await importPaths(db, [rom('mystere.iso', 'zzz')], opt())).items[0].status).toBe('ambiguous')
  })
  it('emporte les pistes d’une feuille .cue et ne les importe pas seules', async () => {
    rom('Disc (Track 1).bin', 'track'); const cue = rom('Disc.cue', 'FILE "Disc (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n')
    const r = await importPaths(db, [join(dir, 'src')], { ...opt(), copy: true })
    expect(r.items).toHaveLength(1)
    expect(r.items[0].file).toBe(cue) // console ambiguë ps1/ps2 → non importée, mais une seule entrée (la piste est absorbée)
    expect(r.items[0].status).toBe('ambiguous')
  })
})
