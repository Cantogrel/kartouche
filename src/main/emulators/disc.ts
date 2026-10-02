import { open, readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { openChd } from './chd'

// Lecture minimale d'une image de disque ISO 9660 (PS1, PS2, PSP, PS3), brute (.iso/.bin/.cue) ou compressée (.chd, .cso, .zso) : un fichier de la racine, sans décompresser ni dépendre de l'émulateur. Sert à retrouver le
// numéro de série (SYSTEM.CNF) et le CRC de l'exécutable d'un jeu pour les réglages par jeu de DuckStation et PCSX2.

/** Image lisible par décalage : le fichier brut lui-même, ou le contenu décompressé à la demande d'un .chd / .cso / .zso. */
interface Image { read: (offset: number, length: number) => Promise<Buffer>; close: () => Promise<void>; /** Décalages (en secteurs) à essayer : une image de CD peut garder les 150 secteurs de pause initiale. */ shifts: number[] }

/** Premier fichier de données d'une image : le .bin/.iso/.img lui-même, ou le premier FILE d'une feuille .cue ; null pour un autre format. */
async function dataFile(path: string): Promise<string | null> {
  if (!/^\.cue$/i.test(extname(path))) return /^\.(bin|iso|img)$/i.test(extname(path)) ? path : null
  const file = /^\s*FILE\s+(?:"([^"]+)"|(\S+))/im.exec(await readFile(path, 'latin1'))
  const name = file?.[1] ?? file?.[2]
  return name ? join(dirname(path), name) : null
}

/** Décompresse un bloc LZ4 (format « bloc » brut, celui des .zso). */
export function lz4Block(src: Buffer, outSize: number): Buffer {
  const out = Buffer.alloc(outSize)
  let i = 0, o = 0
  while (i < src.length && o < outSize) {
    const token = src[i++]
    let lit = token >> 4
    if (lit === 15) { let b: number; do { b = src[i++]; lit += b } while (b === 255) }
    src.copy(out, o, i, i + lit); i += lit; o += lit
    if (i >= src.length || o >= outSize) break
    const off = src[i] | (src[i + 1] << 8); i += 2
    let len = token & 15
    if (len === 15) { let b: number; do { b = src[i++]; len += b } while (b === 255) }
    len += 4
    for (let k = 0; k < len && o < outSize; k++, o++) out[o] = out[o - off]
  }
  return out
}

/** .cso (blocs zlib) et .zso (blocs LZ4) : en-tête « CISO »/« ZISO », puis un index de décalages, un par bloc (bit 31 = bloc non compressé). */
async function openCso(path: string): Promise<Image | null> {
  const fh = await open(path, 'r')
  const head = Buffer.alloc(24)
  await fh.read(head, 0, 24, 0)
  const magic = head.toString('latin1', 0, 4)
  if (magic !== 'CISO' && magic !== 'ZISO') { await fh.close(); return null }
  const total = Number(head.readBigUInt64LE(8)), block = head.readUInt32LE(16), align = head[21]
  const blocks = Math.ceil(total / block)
  const index = Buffer.alloc((blocks + 1) * 4)
  await fh.read(index, 0, index.length, 24)
  const blockData = async (n: number): Promise<Buffer> => {
    const a = index.readUInt32LE(n * 4), b = index.readUInt32LE((n + 1) * 4)
    const start = (a & 0x7fffffff) * 2 ** align, len = (b & 0x7fffffff) * 2 ** align - start
    const raw = Buffer.alloc(len)
    await fh.read(raw, 0, len, start)
    if (a & 0x80000000) return raw.subarray(0, block)
    return magic === 'CISO' ? inflateRawSync(raw) : lz4Block(raw, block)
  }
  return {
    shifts: [0],
    read: async (offset, length) => {
      const parts: Buffer[] = []
      for (let pos = offset; pos < offset + length && pos < total;) {
        const n = Math.floor(pos / block), data = await blockData(n), from = pos - n * block
        const take = Math.min(data.length - from, offset + length - pos)
        if (take <= 0) break
        parts.push(data.subarray(from, from + take)); pos += take
      }
      return Buffer.concat(parts)
    },
    close: () => fh.close()
  }
}

async function openImage(path: string): Promise<Image | null> {
  const ext = extname(path).toLowerCase()
  if (ext === '.chd') {
    const c = await openChd(path)
    return c && { read: c.read, close: c.close, shifts: c.kind === 'cd' ? [0, 150] : [0] }
  }
  if (ext === '.cso' || ext === '.zso') return openCso(path)
  const file = await dataFile(path)
  if (!file) return null
  const fh = await open(file, 'r').catch(() => null)
  if (!fh) return null
  return { shifts: [0], read: async (offset, length) => { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return b.subarray(0, bytesRead) }, close: () => fh.close() }
}

/**
 * Lit un fichier du disque jusqu'à `maxBytes` octets : `match` reconnaît le nom d'un fichier de la racine (ex. « SYSTEM.CNF;1 »), ou, en tableau, un chemin
 * dossier par dossier (ex. `[n => n === 'PS3_GAME', n => /^PARAM\.SFO/i.test(n)]`). Les secteurs bruts (2352 octets, données à +16 ou +24) comme ceux de
 * 2048 sont reconnus. Null si le format n'est pas lisible ou si le fichier est introuvable.
 */
export async function readDiscRootFile(path: string, match: ((name: string) => boolean) | ((name: string) => boolean)[], maxBytes: number): Promise<{ name: string; data: Buffer } | null> {
  const chain = Array.isArray(match) ? match : [match]
  const img = await openImage(path).catch(() => null)
  if (!img) return null
  try {
    const read = img.read
    let layout: { sector: number; data: number; shift: number } | null = null
    for (const shift of img.shifts) for (const l of [{ sector: 2048, data: 0 }, { sector: 2352, data: 16 }, { sector: 2352, data: 24 }]) {
      if (!layout && (await read((16 + shift) * l.sector + l.data + 1, 5)).toString('latin1') === 'CD001') layout = { ...l, shift }
    }
    if (!layout) return null
    const { sector, data: dataOffset, shift } = layout
    const at = (lba: number): number => (lba + shift) * sector + dataOffset
    // Un fichier de plus d'un secteur est lu secteur par secteur : en secteurs bruts, les données ne sont pas contiguës.
    const readExtent = async (lba: number, size: number): Promise<Buffer> => {
      const parts: Buffer[] = []
      for (let done = 0; done < size; done += 2048) parts.push(await read(at(lba + done / 2048), Math.min(2048, size - done)))
      return Buffer.concat(parts)
    }
    const pvd = await read(at(16), 2048)
    let dirLba = pvd.readUInt32LE(156 + 2)
    let dirSize = pvd.readUInt32LE(156 + 10)
    for (let depth = 0; depth < chain.length; depth++) {
      const dir = await readExtent(dirLba, Math.min(dirSize, 2048 * 8))
      let found: { name: string; lba: number; size: number } | null = null
      for (let i = 0; i < dir.length;) {
        const len = dir[i]
        if (len === 0) { i = (Math.floor(i / 2048) + 1) * 2048; continue }
        const name = dir.subarray(i + 33, i + 33 + dir[i + 32]).toString('latin1')
        const isDir = (dir[i + 25] & 2) !== 0
        if (isDir === (depth < chain.length - 1) && chain[depth](name)) { found = { name, lba: dir.readUInt32LE(i + 2), size: dir.readUInt32LE(i + 10) }; break }
        i += len
      }
      if (!found) return null
      if (depth === chain.length - 1) return { name: found.name, data: await readExtent(found.lba, Math.min(found.size, maxBytes)) }
      dirLba = found.lba; dirSize = found.size
    }
    return null
  } finally {
    await img.close()
  }
}
