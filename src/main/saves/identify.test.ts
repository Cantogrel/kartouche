import { createCipheriv } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../db/migrations'
import { discIdFromHead, identifyGame, readGameKey, readWiiUTitleId, titleIdFromMetaXml, titleIdFromPartitionTable } from './identify'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-id-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const DECOYS = ['ffeeddccbbaa99887766554433221100', '0123456789abcdef0123456789abcdef', 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0']

/** Table de partitions Wii U en clair : magique, puis une entrée de 0x80 octets par partition à partir de 0x800. */
function toc(partitions: string[]): Buffer {
  const t = Buffer.alloc(0x8000)
  t.writeUInt32BE(0xcca6e67b, 0)
  partitions.forEach((p, i) => { t.write(p, 0x800 + i * 0x80, 'latin1'); t.writeUInt32BE(0x1c000 + i, 0x800 + i * 0x80 + 0x20) })
  return t
}

/** Image .wux : en-tête, index des secteurs, secteurs ; la table des partitions (secteur 3) est chiffrée en AES-128-CBC avec la clé du disque. */
function wux(partitions: string[], key = KEY): Buffer {
  const sector = 0x8000, sectors = 5
  const head = Buffer.alloc(0x20)
  head.write('WUX0', 0, 'latin1'); head.writeUInt32LE(0x1099d02e, 4); head.writeUInt32LE(sector, 8); head.writeBigUInt64LE(BigInt(sector * sectors), 16)
  // Secteurs dédupliqués : les secteurs 1, 2 et 4 (vides) partagent un seul secteur physique.
  const phys = [0, 1, 1, 2, 1]
  const index = Buffer.alloc(sectors * 4)
  phys.forEach((p, i) => index.writeUInt32LE(p, i * 4))
  const dataStart = Math.ceil((0x20 + index.length) / sector) * sector
  const first = Buffer.alloc(sector); first.write('WUP-P-BCZP-00-310EUR-0', 0, 'latin1')
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16)); c.setAutoPadding(false)
  const enc = Buffer.concat([c.update(toc(partitions)), c.final()])
  return Buffer.concat([head, index, Buffer.alloc(dataStart - 0x20 - index.length), first, Buffer.alloc(sector), enc])
}

describe('Title ID Wii U', () => {
  it('lit la table des partitions : le jeu (00050000) prime sur une application système', () => {
    expect(titleIdFromPartitionTable(toc(['SI', 'UP00050010100462000000000', 'GM00050010100600000000000', 'GM000500001019E6000000000']))).toBe('000500001019E600')
    expect(titleIdFromPartitionTable(toc(['SI']))).toBeNull()
  })
  it('.wux : trouve la bonne clé parmi celles de keys.txt et déchiffre la table', async () => {
    mkdirSync(join(dir, 'cemu'))
    writeFileSync(join(dir, 'cemu', 'keys.txt'), [...DECOYS, KEY.toString('hex'), ''].join('\r\n'))
    writeFileSync(join(dir, 'g.wux'), wux(['SI', 'GM00050000101436000000000']))
    expect(await readWiiUTitleId(join(dir, 'g.wux'), join(dir, 'cemu'))).toBe('0005000010143600')
  })
  it('.wux : sans la clé du disque, rien (jamais un identifiant deviné)', async () => {
    mkdirSync(join(dir, 'cemu'))
    writeFileSync(join(dir, 'cemu', 'keys.txt'), DECOYS.join('\n'))
    writeFileSync(join(dir, 'g.wux'), wux(['GM00050000101436000000000']))
    expect(await readWiiUTitleId(join(dir, 'g.wux'), join(dir, 'cemu'))).toBeNull()
    expect(await readWiiUTitleId(join(dir, 'g.wux'))).toBeNull()
  })
  it('.wux : une clé .key voisine du jeu suffit', async () => {
    writeFileSync(join(dir, 'g.wux'), wux(['GM00050000101436000000000']))
    writeFileSync(join(dir, 'g.key'), KEY)
    expect(await readWiiUTitleId(join(dir, 'g.wux'))).toBe('0005000010143600')
  })
  it('.wud brut : même table, sans index de secteurs', async () => {
    const w = wux(['GM000500001019E6000000000'])
    const sector = 0x8000, n = 5, dataStart = Math.ceil((0x20 + n * 4) / sector) * sector
    const wud = Buffer.alloc(sector * n)
    w.copy(wud, 3 * sector, dataStart + 2 * sector, dataStart + 3 * sector)
    writeFileSync(join(dir, 'g.wud'), wud)
    writeFileSync(join(dir, 'g.key'), KEY.toString('hex'))
    expect(await readWiiUTitleId(join(dir, 'g.wud'))).toBe('000500001019E600')
  })
  it('dossier dumpé : meta/meta.xml', async () => {
    mkdirSync(join(dir, 'Zelda', 'code'), { recursive: true }); mkdirSync(join(dir, 'Zelda', 'meta'))
    writeFileSync(join(dir, 'Zelda', 'meta', 'meta.xml'), '<menu><title_id type="hexBinary" length="8">0005000010143500</title_id></menu>')
    expect(await readWiiUTitleId(join(dir, 'Zelda', 'code', 'U-King.rpx'))).toBe('0005000010143500')
    expect(titleIdFromMetaXml('<title_id type="hexBinary" length="8">00050000101c9400</title_id>')).toBe('00050000101C9400')
  })
})

describe('identifiant des autres jeux', () => {
  it("GameCube / Wii : identifiant de disque en clair, ou copié à 0x58 (.rvz) ou 0x200 (.wbfs)", () => {
    expect(discIdFromHead(Buffer.from('GZLP01\0\0'), '.iso')).toBe('GZLP01')
    const rvz = Buffer.alloc(0x60); rvz.write('RMCP01', 0x58, 'latin1')
    expect(discIdFromHead(rvz, '.RVZ')).toBe('RMCP01')
    expect(discIdFromHead(Buffer.alloc(0x60), '.rvz')).toBeNull()
    expect(discIdFromHead(Buffer.from('GZLP01\0\0'), '.gcz')).toBeNull()
  })
  it('3DS : Title ID de la partition 0 d\'une ROM NCSD, sinon celui déjà connu', async () => {
    const ncsd = Buffer.alloc(0x200)
    ncsd.write('NCSD', 0x100, 'latin1'); Buffer.from('00040000000b8b00', 'hex').reverse().copy(ncsd, 0x108)
    writeFileSync(join(dir, 'a.3ds'), ncsd)
    expect(await readGameKey({ id: 1, console: 'n3ds', path: join(dir, 'a.3ds') })).toBe('00040000000B8B00')
    expect(await readGameKey({ id: 2, console: 'n3ds', path: join(dir, 'x.cia'), titleId: '0004000000123400' })).toBe('0004000000123400')
  })
  it('Switch et Vita : identifiant de la bibliothèque', async () => {
    expect(await readGameKey({ id: 1, console: 'switch', path: 'x.nsp', titleId: '0100ABCD00000000' })).toBe('0100ABCD00000000')
    expect(await readGameKey({ id: 2, console: 'vita', path: 'x.zip', vitaTitleId: 'PCSE00097' })).toBe('PCSE00097')
    // Dump sans Title ID en bibliothèque : celui du nom (convention nxdumptool), mais seulement pour un jeu de base — pas pour une mise à jour.
    expect(await readGameKey({ id: 4, console: 'switch', path: 'C:/roms/Mario Kart 8 Deluxe [0100152000022000][v0].nsp' })).toBe('0100152000022000')
    expect(await readGameKey({ id: 5, console: 'switch', path: 'C:/roms/Jeu [0100152000022800][v65536].nsp' })).toBeNull()
    expect(await readGameKey({ id: 3, console: 'vita', path: 'x.zip' })).toBeNull()
  })
  it('mémorise l\'identifiant lu, puis le resert sans relire le jeu', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    db.prepare("INSERT INTO library (id, console, title, path, size, match, added_at) VALUES (7, 'gc', 'Jeu', ?, 1, 'hash', 1)").run(join(dir, 'g.iso'))
    writeFileSync(join(dir, 'g.iso'), Buffer.concat([Buffer.from('GZLP01'), Buffer.alloc(0x300)]))
    const entry = { id: 7, console: 'gc', path: join(dir, 'g.iso') }
    expect(await identifyGame(db, entry)).toBe('GZLP01')
    rmSync(join(dir, 'g.iso'))
    expect(existsSync(entry.path)).toBe(false)
    expect(await identifyGame(db, entry)).toBe('GZLP01')
  })
})
