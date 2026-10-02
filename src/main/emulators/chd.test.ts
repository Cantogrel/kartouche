import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openChd } from './chd'
import { readDiscRootFile } from './disc'
import { readPs1Serial } from './duckstation'
import { readPspDiscId } from './ppsspp'
import { makeChd, makeCso, makeSfo, miniIso, toRawSectors } from './testImages'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-chd-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('openChd', () => {
  it("lit les octets d'une image CHD v5 (table compressée, blocs zlib) d'un bloc à l'autre", async () => {
    const data = Buffer.alloc(4096 * 5)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 8)) & 0xff
    writeFileSync(join(dir, 'a.chd'), makeChd(data, 4096))
    const chd = await openChd(join(dir, 'a.chd'))
    expect(chd?.kind).toBe('raw')
    expect((await chd!.read(4000, 300)).equals(data.subarray(4000, 4300))).toBe(true)
    expect((await chd!.read(4096 * 4 + 10, 100)).equals(data.subarray(4096 * 4 + 10, 4096 * 4 + 110))).toBe(true)
    await chd!.close()
  })
  it('suit une référence à un autre bloc de la même image', async () => {
    const data = Buffer.concat([Buffer.alloc(4096, 1), Buffer.alloc(4096, 2), Buffer.alloc(4096, 9)])
    writeFileSync(join(dir, 's.chd'), makeChd(data, 4096, { selfLast: true }))
    const chd = await openChd(join(dir, 's.chd'))
    // Le dernier bloc renvoie au dernier bloc référencé (le premier : aucun renvoi explicite n'a précédé).
    expect((await chd!.read(8192, 4)).equals(Buffer.alloc(4, 1))).toBe(true)
    await chd!.close()
  })
  it("refuse ce qui n'est pas un CHD v5", async () => {
    writeFileSync(join(dir, 'x.chd'), Buffer.alloc(200))
    expect(await openChd(join(dir, 'x.chd'))).toBeNull()
  })
})

describe('numéro de série dans une image compressée', () => {
  it('PSP : image CHD de type DVD (secteurs de 2048 octets)', async () => {
    writeFileSync(join(dir, 'psp.chd'), makeChd(miniIso('PARAM.SFO;1', makeSfo('DISC_ID', 'ULES01275'), ['PSP_GAME']), 4096))
    expect(await readPspDiscId(join(dir, 'psp.chd'))).toBe('ULES01275')
  })
  it('PS1 : image CHD de type CD (cdzl, secteurs de 2352 octets + sous-code)', async () => {
    const raw = toRawSectors(miniIso('SYSTEM.CNF;1', 'BOOT = cdrom:\\SCES_014.38;1\r\n'))
    writeFileSync(join(dir, 'ps1.chd'), makeChd(raw, 8 * 2448, { cd: true }))
    expect(await readPs1Serial(join(dir, 'ps1.chd'))).toBe('SCES-01438')
  })
  it('PSP : .cso (zlib) et .zso (LZ4)', async () => {
    const iso = miniIso('PARAM.SFO;1', makeSfo('DISC_ID', 'ULUS10041'), ['PSP_GAME'])
    writeFileSync(join(dir, 'a.cso'), makeCso(iso, 'cso'))
    writeFileSync(join(dir, 'a.zso'), makeCso(iso, 'zso'))
    expect(await readPspDiscId(join(dir, 'a.cso'))).toBe('ULUS10041')
    expect(await readPspDiscId(join(dir, 'a.zso'))).toBe('ULUS10041')
  })
  it('PS1 : .bin brut en secteurs de 2352 octets', async () => {
    writeFileSync(join(dir, 'g.bin'), toRawSectors(miniIso('SYSTEM.CNF;1', 'BOOT = cdrom:\\SLUS_006.94;1\r\n')))
    expect(await readPs1Serial(join(dir, 'g.bin'))).toBe('SLUS-00694')
  })
  it('image illisible ou inconnue : null (jamais une exception)', async () => {
    writeFileSync(join(dir, 'z.chd'), Buffer.alloc(300))
    expect(await readDiscRootFile(join(dir, 'z.chd'), () => true, 10)).toBeNull()
    expect(await readDiscRootFile(join(dir, 'absent.cso'), () => true, 10)).toBeNull()
  })
})

const REAL_PSP = 'E:/dev/RomVault/data/roms/psp/God%20of%20War%20-%20Chains%20of%20Olympus%20%28Europe%2C%20Australia%29%20%28En%2CFr%2CDe%2CEs%2CIt%29.chd'
describe.skipIf(!existsSync(REAL_PSP))('image réelle (bibliothèque de développement)', () => {
  it('God of War : Chains of Olympus (CHD zstd, table de blocs de chdman) → UCES00842', async () => {
    expect(await readPspDiscId(REAL_PSP)).toBe('UCES00842')
  })
})
