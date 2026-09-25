import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'

export interface FileHash { crc: string; sha1: string; size: number }

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')

/** CRC32 et SHA1 d'un fichier en une seule lecture en flux (les ISO font plusieurs Go). */
export async function hashFile(path: string): Promise<FileHash> {
  const sha = createHash('sha1')
  let crc = 0
  let size = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
    const b = chunk as Buffer
    sha.update(b)
    crc = crc32(b, crc)
    size += b.length
  }
  return { crc: hex8(crc), sha1: sha.digest('hex'), size }
}

export interface ZipInfo { name: string; crc: string; size: number }

/**
 * Contenu d'une archive zip lu dans son répertoire central : nom, CRC32 et taille de chaque fichier, sans rien décompresser.
 * Renvoie null si le fichier n'est pas un zip lisible.
 */
export async function readZip(path: string): Promise<ZipInfo[] | null> {
  const fh = await open(path, 'r')
  try {
    const { size } = await stat(path)
    const tailLen = Math.min(size, 65557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let e = -1
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break }
    if (e < 0) return null
    const count = tail.readUInt16LE(e + 10)
    const cdSize = tail.readUInt32LE(e + 12)
    const cdOff = tail.readUInt32LE(e + 16)
    if (cdOff === 0xffffffff || cdOff + cdSize > size) return null // zip64 : non géré
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOff)
    const out: ZipInfo[] = []
    let p = 0
    for (let n = 0; n < count && p + 46 <= cdSize; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return null
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      if (!name.endsWith('/')) out.push({ name, crc: hex8(cd.readUInt32LE(p + 16)), size: cd.readUInt32LE(p + 24) })
      p += 46 + nameLen + extraLen + commentLen
    }
    return out
  } finally { await fh.close() }
}
