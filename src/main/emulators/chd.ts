import { open, type FileHandle } from 'node:fs/promises'
import { inflateRawSync, zstdDecompressSync } from 'node:zlib'
import { lzmaDecode } from './lzma'

// Lecture minimale d'une image CHD v5 (le format de MAME, repris par DuckStation, PCSX2, PPSSPP…) : assez pour lire les premiers secteurs du disque
// (ISO 9660 : numéro de série du jeu) sans décompresser l'image entière ni dépendre d'un émulateur. Codecs gérés : zlib, lzma, cdzl, cdlz (les codecs de
// données de chdman) ; huff et flac (audio / cas rares) ne le sont pas, ni les CHD à parent.
// Références : spécification du format de MAME (chd.h / chd.cpp) et libchdr ; l'exactitude est vérifiée sur une image réelle (voir chd.test.ts).

const tag = (s: string): number => Buffer.from(s, 'latin1').readUInt32BE(0)
const TAGS = { zlib: tag('zlib'), lzma: tag('lzma'), zstd: tag('zstd'), cdzl: tag('cdzl'), cdlz: tag('cdlz'), cdzs: tag('cdzs') }

const CD_FRAME = 2448 // 2352 octets de secteur + 96 de sous-code
const CD_SECTOR = 2352

// Types de blocs de la table (v5).
const COMP_NONE = 4, COMP_SELF = 5, COMP_PARENT = 6, COMP_RLE_SMALL = 7, COMP_RLE_LARGE = 8, COMP_SELF_0 = 9, COMP_SELF_1 = 10, COMP_PARENT_SELF = 11, COMP_PARENT_0 = 12, COMP_PARENT_1 = 13

interface MapEntry { comp: number; length: number; offset: number }

class Bits {
  private pos = 0
  constructor(private readonly buf: Buffer) {}
  read(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3] ?? 0
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1)
      this.pos++
    }
    return v
  }
  peek(n: number): number { const p = this.pos; const v = this.read(n); this.pos = p; return v }
  skip(n: number): void { this.pos += n }
}

/** Décodeur de Huffman canonique (16 codes, 8 bits au plus) de la table des blocs. */
function readHuffman(bits: Bits): { decode: () => number } {
  const numCodes = 16, maxBits = 8, numBits = 4
  const lens = new Array<number>(numCodes).fill(0)
  for (let cur = 0; cur < numCodes;) {
    const n = bits.read(numBits)
    if (n !== 1) { lens[cur++] = n; continue }
    const n2 = bits.read(numBits)
    if (n2 === 1) { lens[cur++] = 1; continue }
    let rep = bits.read(numBits) + 3
    while (rep-- > 0 && cur < numCodes) lens[cur++] = n2
  }
  // Codes canoniques, attribués du plus long au plus court.
  const histo = new Array<number>(maxBits + 1).fill(0)
  for (const l of lens) if (l > 0 && l <= maxBits) histo[l]++
  let start = 0
  const first = new Array<number>(maxBits + 1).fill(0)
  for (let l = maxBits; l >= 1; l--) { const nextStart = (start + histo[l]) >> 1; first[l] = start; start = nextStart }
  const table = new Map<number, number>() // (longueur << 16 | code) -> symbole
  for (let sym = 0; sym < numCodes; sym++) {
    const l = lens[sym]
    if (l > 0) table.set((l << 16) | first[l]++, sym)
  }
  return {
    decode: (): number => {
      for (let l = 1; l <= maxBits; l++) {
        const s = table.get((l << 16) | bits.peek(l))
        if (s !== undefined) { bits.skip(l); return s }
      }
      throw new Error('CHD : code de Huffman invalide')
    }
  }
}

function decodeMap(raw: Buffer, hunkCount: number, hunkBytes: number): MapEntry[] {
  const mapBytes = raw.readUInt32BE(0)
  const first = raw.readUIntBE(4, 6)
  const lengthBits = raw[12], selfBits = raw[13], parentBits = raw[14]
  const bits = new Bits(raw.subarray(16, 16 + mapBytes))
  const huff = readHuffman(bits)
  const types: number[] = new Array<number>(hunkCount)
  let rep = 0, last = 0
  for (let i = 0; i < hunkCount; i++) {
    if (rep > 0) { types[i] = last; rep--; continue }
    const v = huff.decode()
    if (v === COMP_RLE_SMALL) { types[i] = last; rep = 2 + huff.decode() }
    else if (v === COMP_RLE_LARGE) { types[i] = last; rep = 2 + 16 + (huff.decode() << 4); rep += huff.decode() }
    else types[i] = last = v
  }
  const map: MapEntry[] = []
  let cur = first, lastSelf = 0, lastParent = 0
  for (let i = 0; i < hunkCount; i++) {
    const c = types[i]
    if (c <= 3) { const length = bits.read(lengthBits); map.push({ comp: c, length, offset: cur }); cur += length; bits.skip(16) }
    else if (c === COMP_NONE) { map.push({ comp: COMP_NONE, length: hunkBytes, offset: cur }); cur += hunkBytes; bits.skip(16) }
    else if (c === COMP_SELF) { lastSelf = bits.read(selfBits); map.push({ comp: COMP_SELF, length: 0, offset: lastSelf }) }
    else if (c === COMP_PARENT) { lastParent = bits.read(parentBits); map.push({ comp: COMP_PARENT, length: 0, offset: lastParent }) }
    else if (c === COMP_SELF_0) map.push({ comp: COMP_SELF, length: 0, offset: lastSelf })
    else if (c === COMP_SELF_1) { lastSelf++; map.push({ comp: COMP_SELF, length: 0, offset: lastSelf }) }
    else if (c === COMP_PARENT_SELF || c === COMP_PARENT_0 || c === COMP_PARENT_1) map.push({ comp: COMP_PARENT, length: 0, offset: 0 })
    else throw new Error('CHD : type de bloc inconnu')
  }
  return map
}

export interface ChdImage {
  /** `cd` : image de CD (secteurs de 2352 octets rendus l'un après l'autre) ; `raw` : octets du disque tels quels (DVD, UMD). */
  kind: 'cd' | 'raw'
  read: (offset: number, length: number) => Promise<Buffer>
  close: () => Promise<void>
}

/** Ouvre un CHD v5 ; null si ce n'est pas un CHD v5, ou si ses codecs de données ne sont pas gérés. */
export async function openChd(path: string): Promise<ChdImage | null> {
  const fh: FileHandle = await open(path, 'r')
  try {
    const head = Buffer.alloc(124)
    await fh.read(head, 0, 124, 0)
    if (head.toString('latin1', 0, 8) !== 'MComprHD' || head.readUInt32BE(12) !== 5) { await fh.close(); return null }
    const comps = [0, 1, 2, 3].map((i) => head.readUInt32BE(16 + i * 4))
    const logical = Number(head.readBigUInt64BE(32))
    const mapOffset = Number(head.readBigUInt64BE(40))
    const hunkBytes = head.readUInt32BE(56)
    const hunkCount = Math.ceil(logical / hunkBytes)
    const supported = new Set([TAGS.zlib, TAGS.lzma, TAGS.zstd, TAGS.cdzl, TAGS.cdlz, TAGS.cdzs])
    const isCd = comps[0] === TAGS.cdzl || comps[0] === TAGS.cdlz || comps[0] === TAGS.cdzs
    if (comps[0] !== 0 && !comps.filter((c) => c !== 0).every((c) => supported.has(c) || c === tag('cdfl') || c === tag('flac') || c === tag('huff'))) { await fh.close(); return null }
    let map: MapEntry[]
    if (comps[0] === 0) {
      const raw = Buffer.alloc(hunkCount * 4)
      await fh.read(raw, 0, raw.length, mapOffset)
      map = Array.from({ length: hunkCount }, (_, i) => ({ comp: COMP_NONE, length: hunkBytes, offset: raw.readUInt32BE(i * 4) * hunkBytes }))
    } else {
      const lenHead = Buffer.alloc(16)
      await fh.read(lenHead, 0, 16, mapOffset)
      const raw = Buffer.alloc(16 + lenHead.readUInt32BE(0))
      await fh.read(raw, 0, raw.length, mapOffset)
      map = decodeMap(raw, hunkCount, hunkBytes)
    }
    const cache = new Map<number, Buffer>()
    const hunk = async (n: number, depth = 0): Promise<Buffer> => {
      const hit = cache.get(n)
      if (hit) return hit
      const e = map[n]
      if (!e || depth > 8) throw new Error('CHD : bloc introuvable')
      let out: Buffer
      if (e.comp === COMP_SELF) out = await hunk(e.offset, depth + 1)
      else if (e.comp === COMP_PARENT) throw new Error('CHD : parent non géré')
      else {
        const data = Buffer.alloc(e.length)
        await fh.read(data, 0, e.length, e.offset)
        out = e.comp === COMP_NONE ? data : decompress(comps[e.comp], data, hunkBytes)
        if (isCd) out = e.comp === COMP_NONE ? stripSubcode(out) : out
      }
      if (cache.size > 16) cache.delete(cache.keys().next().value as number)
      cache.set(n, out)
      return out
    }
    const unit = isCd ? (hunkBytes / CD_FRAME) * CD_SECTOR : hunkBytes
    return {
      kind: isCd ? 'cd' : 'raw',
      read: async (offset, length) => {
        const parts: Buffer[] = []
        for (let pos = offset; pos < offset + length;) {
          const n = Math.floor(pos / unit)
          if (n >= hunkCount) break
          const h = await hunk(n)
          const from = pos - n * unit
          const take = Math.min(h.length - from, offset + length - pos)
          if (take <= 0) break
          parts.push(h.subarray(from, from + take))
          pos += take
        }
        return Buffer.concat(parts)
      },
      close: () => fh.close()
    }
  } catch (e) {
    await fh.close().catch(() => {})
    throw e
  }
}

function stripSubcode(h: Buffer): Buffer {
  const frames = h.length / CD_FRAME
  const out = Buffer.alloc(frames * CD_SECTOR)
  for (let i = 0; i < frames; i++) h.copy(out, i * CD_SECTOR, i * CD_FRAME, i * CD_FRAME + CD_SECTOR)
  return out
}

function decompress(codec: number, data: Buffer, hunkBytes: number): Buffer {
  if (codec === TAGS.zlib) return inflateRawSync(data)
  if (codec === TAGS.zstd) return zstdDecompressSync(data)
  if (codec === TAGS.lzma) return lzmaDecode(data, hunkBytes)
  if (codec === TAGS.cdzl || codec === TAGS.cdlz || codec === TAGS.cdzs) {
    const frames = hunkBytes / CD_FRAME
    const ecc = Math.ceil(frames / 8)
    const lenBytes = hunkBytes < 65536 ? 2 : 3
    const baseLen = lenBytes === 2 ? data.readUInt16BE(ecc) : data.readUIntBE(ecc, 3)
    const header = ecc + lenBytes
    const base = data.subarray(header, header + baseLen)
    return codec === TAGS.cdlz ? lzmaDecode(base, frames * CD_SECTOR) : codec === TAGS.cdzs ? zstdDecompressSync(base) : inflateRawSync(base)
  }
  throw new Error('CHD : codec non géré')
}
