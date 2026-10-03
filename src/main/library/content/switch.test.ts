import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanLabel, parseCnmt, parseCnmtXml, parseKeys, parsePfs0, probeNsp, rightsIdFromTicket } from './switch'

// --- Tests réels : de vrais NSP (Animal Crossing: New Horizons) et le prod.keys de l'Eden installé sur la machine de développement. ---
// Ignorés sur toute autre machine. Ils valident la lecture du conteneur (PFS0, ticket, XML, NCA de métadonnées déchiffré), PAS l'installation
// dans Eden (voir emulators/content/eden.ts, test réel séparé).
const NSP_DIR = String.raw`C:\Users\mathc\Downloads\Animal Crossing New Horizons [NSP]`
const KEYS = String.raw`E:\dev\RomVault\data\emulators\eden\user\keys\prod.keys`
const BASE = join(NSP_DIR, 'Animal Crossing New Horizons [01006F8002326000][v0].nsp')
const UPDATE = join(NSP_DIR, 'Animal Crossing New Horizons [01006F8002326800][v1966080].nsp')
const DLC_HHP = join(NSP_DIR, 'Animal Crossing New Horizons [DLC Happy Home Paradise] [01006F80023273E8][v0].nsp')
const DLC_NOTIK = join(NSP_DIR, '2 DLCs + Alt', 'Alternate DLC (without tickets)', 'Animal Crossing New Horizons [DLC Nook Inc silk rug] [01006F800232712D][v0].nsp')
const real = existsSync(BASE) && existsSync(KEYS) ? it : it.skip
const ctx = { switchKeysFile: KEYS }

describe('probeNsp — vrais NSP', () => {
  real('jeu de base (aucun ticket ni XML : seul le NCA de métadonnées déchiffré donne l’identité)', async () => {
    expect(await probeNsp(BASE, ctx)).toMatchObject({ console: 'switch', kind: 'base', titleId: '01006F8002326000', baseKey: '01006F8002326000', version: '0', source: 'container' })
  })
  real('mise à jour : parent et version lus dans le CNMT', async () => {
    expect(await probeNsp(UPDATE, ctx)).toMatchObject({ kind: 'update', titleId: '01006F8002326800', baseKey: '01006F8002326000', version: '1966080', source: 'container' })
  })
  real('DLC avec ticket', async () => {
    expect(await probeNsp(DLC_HHP, ctx)).toMatchObject({ kind: 'dlc', titleId: '01006F80023273E8', baseKey: '01006F8002326000', version: '0' })
  })
  real('DLC « sans ticket » (identifié par le CNMT, pas par un ticket)', async () => {
    expect(await probeNsp(DLC_NOTIK, ctx)).toMatchObject({ kind: 'dlc', titleId: '01006F800232712D', baseKey: '01006F8002326000' })
  })
  real('sans prod.keys, repli sur le .cnmt.xml (jeu de base) ou le ticket (mise à jour, DLC)', async () => {
    expect(await probeNsp(UPDATE, {})).toMatchObject({ kind: 'update', titleId: '01006F8002326800', baseKey: '01006F8002326000', source: 'container' })
    expect(await probeNsp(DLC_NOTIK, {})).toMatchObject({ kind: 'dlc', titleId: '01006F800232712D', baseKey: '01006F8002326000', source: 'container' })
    expect(await probeNsp(BASE, {})).toMatchObject({ kind: 'base', titleId: '01006F8002326000', source: 'container' })
  })
})

// --- Tests synthétiques : formats construits à la main (valident l’analyse, pas le comportement réel d’Eden). ---
describe('parsePfs0', () => {
  it('lit la table des fichiers', () => {
    const names = Buffer.from('a.tik\0b.nca\0')
    const head = Buffer.alloc(16 + 48 + names.length)
    head.write('PFS0', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(names.length, 8)
    head.writeBigUInt64LE(0n, 16); head.writeBigUInt64LE(10n, 24); head.writeUInt32LE(0, 32)
    head.writeBigUInt64LE(10n, 40); head.writeBigUInt64LE(20n, 48); head.writeUInt32LE(6, 56)
    names.copy(head, 64)
    const base = 16 + 48 + names.length
    expect(parsePfs0(head)).toEqual([{ name: 'a.tik', offset: base, size: 10 }, { name: 'b.nca', offset: base + 10, size: 20 }])
  })
  it('refuse autre chose qu’un PFS0', () => { expect(parsePfs0(Buffer.alloc(64))).toBeNull() })
})

describe('parseCnmt', () => {
  const cnmt = (type: number, id: bigint, app?: bigint): Buffer => {
    const b = Buffer.alloc(0x30)
    b.writeBigUInt64LE(id, 0); b.writeUInt32LE(65536, 8); b.writeUInt8(type, 0x0c); b.writeUInt16LE(app === undefined ? 0 : 0x10, 0x0e)
    if (app !== undefined) b.writeBigUInt64LE(app, 0x20)
    return b
  }
  it('mise à jour : jeu parent dans l’en-tête étendu', () => {
    expect(parseCnmt(cnmt(0x81, 0x0100000000010800n, 0x0100000000010000n))).toEqual({ type: 0x81, titleId: '0100000000010800', version: 65536, applicationId: '0100000000010000' })
  })
  it('DLC : idem', () => { expect(parseCnmt(cnmt(0x82, 0x0100000000011001n, 0x0100000000010000n))?.applicationId).toBe('0100000000010000') })
  it('jeu de base : pas de parent', () => { expect(parseCnmt(cnmt(0x80, 0x0100000000010000n))?.applicationId).toBeNull() })
})

describe('parseCnmtXml / rightsIdFromTicket / parseKeys', () => {
  it('XML nxdumptool', () => {
    expect(parseCnmtXml('<ContentMeta><Type>Patch</Type><Id>0x01006f8002326800</Id><Version>1966080</Version><OriginalId>0x01006f8002326000</OriginalId></ContentMeta>'))
      .toEqual({ type: 0x81, titleId: '01006F8002326800', version: 1966080, applicationId: '01006F8002326000' })
  })
  it('ticket RSA-2048 SHA-256 : Rights ID à 0x2A0', () => {
    const tik = Buffer.alloc(0x2c0)
    tik.writeUInt32LE(0x010004, 0)
    Buffer.from('01006f8002326800000000000000000b', 'hex').copy(tik, 0x2a0)
    expect(rightsIdFromTicket(tik)).toBe('01006F8002326800000000000000000B')
  })
  it('prod.keys', () => { expect(parseKeys('header_key = 00ff\n; commentaire\nTitlekek_0b=AB').get('titlekek_0b')).toEqual(Buffer.from('ab', 'hex')) })
})

describe('cleanLabel', () => {
  it('retire Title ID et version', () => { expect(cleanLabel('Animal Crossing New Horizons [DLC Happy Home Paradise] [01006F80023273E8][v0]')).toBe('Animal Crossing New Horizons [DLC Happy Home Paradise]') })
})
