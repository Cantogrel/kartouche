import { afterEach, describe, expect, it } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { decompressNsz, isNsz, unpackNsz } from './nsz'

// Un .nsz fabriqué selon le format du projet « nsz » : NCA déchiffré+compressé (NCZSECTN, solid ou NCZBLOCK), rechiffré par la décompression en AES-CTR, vérifié par son nom (SHA-256).

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'rv-nsz-')); dirs.push(d); return d }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

interface Sec { offset: number; size: number; type: number; key: Buffer; ctr: Buffer }
const u64 = (n: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }

/** NCA d'origine (en-tête + sections chiffrées en CTR) et sa version « claire » telle que stockée dans un .ncz. */
function makeNca(sizes: number[], types: number[]): { nca: Buffer; plain: Buffer; header: Buffer; secs: Sec[] } {
  const header = randomBytes(0x4000)
  const secs: Sec[] = []
  let off = 0x4000
  sizes.forEach((size, i) => {
    secs.push({ offset: off, size, type: types[i], key: randomBytes(16), ctr: Buffer.concat([randomBytes(8), Buffer.alloc(8)]) })
    off += size
  })
  const plain = randomBytes(off - 0x4000)
  const enc: Buffer[] = []
  for (const s of secs) {
    const part = plain.subarray(s.offset - 0x4000, s.offset - 0x4000 + s.size)
    if (s.type === 3) {
      const iv = Buffer.alloc(16); s.ctr.copy(iv, 0, 0, 8); iv.writeBigUInt64BE(BigInt(s.offset / 16), 8)
      enc.push(createCipheriv('aes-128-ctr', s.key, iv).update(part))
    } else enc.push(Buffer.from(part))
  }
  return { nca: Buffer.concat([header, ...enc]), plain, header, secs }
}

function makeNcz(header: Buffer, secs: Sec[], plain: Buffer, mode: 'solid' | 'block'): Buffer {
  const table = Buffer.concat(secs.map((s) => Buffer.concat([u64(s.offset), u64(s.size), u64(s.type), u64(0), s.key, s.ctr])))
  const parts = [header, Buffer.from('NCZSECTN'), u64(secs.length), table]
  if (mode === 'solid') parts.push(zstdCompressSync(plain))
  else {
    const exp = 14, bs = 1 << exp
    const blocks: Buffer[] = []
    for (let o = 0; o < plain.length; o += bs) {
      const raw = plain.subarray(o, Math.min(o + bs, plain.length))
      const c = zstdCompressSync(raw)
      blocks.push(c.length < raw.length ? c : raw) // incompressible : bloc stocké tel quel
    }
    const h = Buffer.alloc(24)
    h.write('NCZBLOCK', 0, 'latin1'); h[8] = 2; h[9] = 1; h[10] = 0; h[11] = exp
    h.writeUInt32LE(blocks.length, 12); h.writeBigUInt64LE(BigInt(plain.length), 16)
    const list = Buffer.alloc(blocks.length * 4)
    blocks.forEach((b, i) => list.writeUInt32LE(b.length, i * 4))
    parts.push(h, list, ...blocks)
  }
  return Buffer.concat(parts)
}

function makePfs0(files: { name: string; data: Buffer }[]): Buffer {
  const names = files.map((f) => Buffer.from(`${f.name}\0`))
  const strSize = names.reduce((n, b) => n + b.length, 0)
  const head = Buffer.alloc(16 + files.length * 24 + strSize)
  head.write('PFS0', 0, 'latin1'); head.writeUInt32LE(files.length, 4); head.writeUInt32LE(strSize, 8)
  let off = 0, no = 0
  files.forEach((f, i) => {
    head.writeBigUInt64LE(BigInt(off), 16 + i * 24); head.writeBigUInt64LE(BigInt(f.data.length), 16 + i * 24 + 8); head.writeUInt32LE(no, 16 + i * 24 + 16)
    names[i].copy(head, 16 + files.length * 24 + no); off += f.data.length; no += names[i].length
  })
  return Buffer.concat([head, ...files.map((f) => f.data)])
}

const idOf = (nca: Buffer): string => createHash('sha256').update(nca).digest('hex').slice(0, 32)

function build(mode: 'solid' | 'block', tamper?: (ncz: Buffer) => Buffer): { nsz: Buffer; nca: Buffer; name: string; other: Buffer } {
  const { nca, plain, header, secs } = makeNca([0x10000, 0x23450, 0x8000 + 16], [3, 3, 1])
  const name = idOf(nca)
  const ncz = makeNcz(header, secs, plain, mode)
  const other = Buffer.from('<ContentMeta/>')
  const nsz = makePfs0([{ name: `${name}.ncz`, data: tamper ? tamper(ncz) : ncz }, { name: 'abc.cnmt.xml', data: other }])
  return { nsz, nca, name, other }
}

/** Contenu des fichiers d'un PFS0 (lecteur indépendant du code testé). */
function readPfs0(buf: Buffer): Map<string, Buffer> {
  const n = buf.readUInt32LE(4), str = buf.readUInt32LE(8), base = 16 + n * 24 + str
  const out = new Map<string, Buffer>()
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 24, no = buf.readUInt32LE(o + 16), start = 16 + n * 24 + no
    const at = base + Number(buf.readBigUInt64LE(o))
    out.set(buf.toString('utf8', start, buf.indexOf(0, start)), buf.subarray(at, at + Number(buf.readBigUInt64LE(o + 8))))
  }
  return out
}

describe('decompressNsz', () => {
  for (const mode of ['solid', 'block'] as const) {
    it(`${mode} : redonne l’NCA d’origine octet pour octet, copie les autres fichiers, le .ncz devient un .nca`, async () => {
      const { nsz, nca, name, other } = build(mode)
      const d = tmp(); writeFileSync(join(d, 'a.nsz'), nsz)
      await decompressNsz(join(d, 'a.nsz'), join(d, 'out', 'a.nsp'))
      const files = readPfs0(readFileSync(join(d, 'out', 'a.nsp')))
      expect([...files.keys()]).toEqual([`${name}.nca`, 'abc.cnmt.xml'])
      expect(files.get(`${name}.nca`)!.equals(nca)).toBe(true)
      expect(files.get('abc.cnmt.xml')!.equals(other)).toBe(true)
    })
  }

  it('contenu altéré : refusé (empreinte différente du nom) et aucun .nsp laissé', async () => {
    const { nsz } = build('solid')
    // Un octet de l’en-tête NCA change : les sections sont identiques mais l’empreinte du NCA ne correspond plus à son nom.
    const bad = Buffer.from(nsz)
    bad[16 + 2 * 24 + 64 + 0x100] ^= 0xff
    const d = tmp(); writeFileSync(join(d, 'a.nsz'), bad)
    await expect(decompressNsz(join(d, 'a.nsz'), join(d, 'a.nsp'))).rejects.toThrow(/empreinte/)
    expect(existsSync(join(d, 'a.nsp'))).toBe(false)
  })

  it('fichier tronqué ou clé erronée : refusé', async () => {
    const { nsz } = build('solid')
    const d = tmp(); writeFileSync(join(d, 'cut.nsz'), nsz.subarray(0, nsz.length - 3000))
    await expect(decompressNsz(join(d, 'cut.nsz'), join(d, 'cut.nsp'))).rejects.toThrow()
    const wrongKey = build('solid', (ncz) => { const c = Buffer.from(ncz); c[0x4000 + 16 + 32] ^= 1; return c })
    writeFileSync(join(d, 'key.nsz'), wrongKey.nsz)
    await expect(decompressNsz(join(d, 'key.nsz'), join(d, 'key.nsp'))).rejects.toThrow(/empreinte/)
    expect(existsSync(join(d, 'key.nsp'))).toBe(false)
  })

  it('un fichier qui n’est pas un .nsz est refusé proprement', async () => {
    const d = tmp(); writeFileSync(join(d, 'x.nsz'), Buffer.from('rien à voir'))
    await expect(decompressNsz(join(d, 'x.nsz'), join(d, 'x.nsp'))).rejects.toThrow()
    expect(await unpackNsz(join(d, 'x.nsz'), join(d, 'w'))).toMatch(/\.nsz illisible/)
  })

  it('unpackNsz : .nsp dans le dossier de travail, même nom', async () => {
    const { nsz } = build('solid')
    const d = tmp(); writeFileSync(join(d, 'Jeu [0100AAAA00000000][v0].nsz'), nsz)
    const r = await unpackNsz(join(d, 'Jeu [0100AAAA00000000][v0].nsz'), join(d, 'w'))
    expect(typeof r).toBe('object')
    if (typeof r === 'object') { expect(r.file).toBe(join(d, 'w', 'content', 'Jeu [0100AAAA00000000][v0].nsp')); expect(existsSync(r.file)).toBe(true) }
    expect(isNsz('a.NSZ')).toBe(true)
    expect(isNsz('a.nsp')).toBe(false)
  })
})
