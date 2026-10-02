import { deflateRawSync } from 'node:zlib'

// Images de disque minuscules pour les tests (jamais importé par l'application) : ISO 9660, PARAM.SFO, CHD v5, CSO / ZSO.

/** PARAM.SFO avec une seule clé texte. */
export function makeSfo(key: string, value: string): Buffer {
  const keyTable = 20 + 16, dataTable = keyTable + 16
  const b = Buffer.alloc(dataTable + 32)
  b.writeUInt32LE(0x46535000, 0); b.writeUInt32LE(0x101, 4); b.writeUInt32LE(keyTable, 8); b.writeUInt32LE(dataTable, 12); b.writeUInt32LE(1, 16)
  b.writeUInt16LE(0, 20); b.writeUInt16LE(0x204, 22); b.writeUInt32LE(value.length + 1, 24); b.writeUInt32LE(32, 28); b.writeUInt32LE(0, 32)
  b.write(key, keyTable, 'latin1'); b.write(value, dataTable, 'latin1')
  return b
}

/** Image ISO 9660 minimale (secteurs de 2048 octets) : `dirs` imbriqués depuis la racine, puis un fichier `name`. Chaque niveau tient dans un secteur. */
export function miniIso(name: string, content: Buffer | string, dirs: string[] = []): Buffer {
  const data = typeof content === 'string' ? Buffer.from(content, 'latin1') : content
  const iso = Buffer.alloc(2048 * 40)
  iso.write('CD001', 16 * 2048 + 1, 'latin1')
  let lba = 18
  const rootLba = lba++
  iso.writeUInt32LE(rootLba, 16 * 2048 + 156 + 2); iso.writeUInt32LE(2048, 16 * 2048 + 156 + 10)
  let cur = rootLba
  const levels = [...dirs, name]
  levels.forEach((nm, i) => {
    const last = i === levels.length - 1
    const next = lba++
    const at = cur * 2048
    iso[at] = 33 + nm.length + ((33 + nm.length) % 2); iso.writeUInt32LE(next, at + 2); iso.writeUInt32LE(last ? data.length : 2048, at + 10)
    iso[at + 25] = last ? 0 : 2; iso[at + 32] = nm.length; iso.write(nm, at + 33, 'latin1')
    if (last) data.copy(iso, next * 2048)
    cur = next
  })
  return iso
}

/** Les mêmes secteurs au format brut d'un CD (2352 octets, mode 2 forme 1 : données à +24). */
export function toRawSectors(iso: Buffer): Buffer {
  const sectors = iso.length / 2048
  const raw = Buffer.alloc(sectors * 2352)
  for (let s = 0; s < sectors; s++) iso.copy(raw, s * 2352 + 24, s * 2048, s * 2048 + 2048)
  return raw
}

class BitWriter {
  private bits: number[] = []
  put(value: number, n: number): void { for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1) }
  bytes(): Buffer {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8))
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7) })
    return out
  }
}

/**
 * CHD v5 à blocs zlib, table des blocs compressée à la façon de chdman (16 codes de 4 bits, un type par bloc, puis longueur + CRC de chaque bloc).
 * `cd` : image de CD (codec cdzl) dont `data` est la suite des secteurs de 2352 octets ; sinon octets bruts (DVD, UMD).
 * `selfLast` : le dernier bloc est une référence « même bloc que le dernier référencé » au lieu de données.
 */
export function makeChd(data: Buffer, hunkBytes: number, opts: { cd?: boolean; selfLast?: boolean } = {}): Buffer {
  const frames = hunkBytes / 2448
  const chunk = opts.cd ? frames * 2352 : hunkBytes
  const hunks: Buffer[] = []
  for (let o = 0; o < data.length; o += chunk) {
    const part = data.subarray(o, o + chunk)
    if (!opts.cd) { hunks.push(deflateRawSync(part)); continue }
    const base = deflateRawSync(Buffer.concat([part, Buffer.alloc(chunk - part.length)]))
    const sub = deflateRawSync(Buffer.alloc(frames * 96))
    const len = Buffer.alloc(2)
    len.writeUInt16BE(base.length)
    hunks.push(Buffer.concat([Buffer.alloc(Math.ceil(frames / 8)), len, base, sub]))
  }
  const w = new BitWriter()
  const lengthBits = 24
  w.put(1, 4); w.put(4, 4); w.put(13, 4) // 16 symboles de 4 bits (1 = échappement, 4 = longueur, 13 + 3 = répétitions)
  const isSelf = (i: number): boolean => !!opts.selfLast && i === hunks.length - 1
  hunks.forEach((_, i) => w.put(isSelf(i) ? 9 : 0, 4)) // 0 = bloc compressé, 9 = « même bloc que le dernier référencé »
  hunks.forEach((h, i) => { if (!isSelf(i)) { w.put(h.length, lengthBits); w.put(0, 16) } })
  const map = w.bytes()
  const mapHead = Buffer.alloc(16)
  mapHead.writeUInt32BE(map.length, 0)
  mapHead.writeUIntBE(124 + 16 + map.length, 4, 6)
  mapHead[12] = lengthBits; mapHead[13] = 8; mapHead[14] = 8
  const head = Buffer.alloc(124)
  head.write('MComprHD', 0, 'latin1'); head.writeUInt32BE(124, 8); head.writeUInt32BE(5, 12)
  head.write(opts.cd ? 'cdzl' : 'zlib', 16, 'latin1')
  const logical = opts.cd ? hunks.length * hunkBytes : data.length
  head.writeBigUInt64BE(BigInt(logical), 32); head.writeBigUInt64BE(124n, 40); head.writeUInt32BE(hunkBytes, 56); head.writeUInt32BE(opts.cd ? 2448 : 2048, 60)
  return Buffer.concat([head, mapHead, map, ...hunks.filter((_, i) => !isSelf(i))])
}

/** Bloc LZ4 fait de littéraux seulement (valide : une séquence finale sans correspondance). */
function lz4Literals(src: Buffer): Buffer {
  let n = src.length
  const ext: number[] = []
  if (n >= 15) { n -= 15; while (n >= 255) { ext.push(255); n -= 255 } ext.push(n) }
  return Buffer.concat([Buffer.from([Math.min(src.length, 15) << 4, ...ext]), src])
}

/** .cso (blocs zlib, « CISO ») ou .zso (blocs LZ4, « ZISO »), blocs de 2048 octets. */
export function makeCso(iso: Buffer, kind: 'cso' | 'zso'): Buffer {
  const block = 2048, count = iso.length / block
  const blocks = Array.from({ length: count }, (_, i) => {
    const raw = iso.subarray(i * block, (i + 1) * block)
    return kind === 'cso' ? deflateRawSync(raw) : lz4Literals(raw)
  })
  const head = Buffer.alloc(24)
  head.write(kind === 'cso' ? 'CISO' : 'ZISO', 0, 'latin1'); head.writeUInt32LE(24, 4); head.writeBigUInt64LE(BigInt(iso.length), 8); head.writeUInt32LE(block, 16); head[20] = 1; head[21] = 0
  const index = Buffer.alloc((count + 1) * 4)
  let off = 24 + index.length
  blocks.forEach((b, i) => { index.writeUInt32LE(off, i * 4); off += b.length })
  index.writeUInt32LE(off, count * 4)
  return Buffer.concat([head, index, ...blocks])
}
