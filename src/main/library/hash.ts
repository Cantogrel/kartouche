import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { constants, crc32, createInflateRaw, inflateRawSync } from 'node:zlib'

export interface FileHash { crc: string; sha1: string; size: number }

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')

/** CRC32 et SHA1 d'un fichier en une seule lecture en flux (les ISO font plusieurs Go). `onBytes` : octets lus jusqu'ici. */
export async function hashFile(path: string, onBytes?: (bytes: number) => void): Promise<FileHash> {
  const sha = createHash('sha1')
  let crc = 0
  let size = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 4 << 20 })) {
    const b = chunk as Buffer
    sha.update(b)
    crc = crc32(b, crc)
    size += b.length
    onBytes?.(size)
  }
  return { crc: hex8(crc), sha1: sha.digest('hex'), size }
}

/**
 * Empreinte ET copie en une seule lecture de la source vers `dest` : pour un import avec copie, évite de relire tout
 * le fichier une 2e fois (empreinte, puis copie) — ~1,5x moins d'E/S sur une ROM de plusieurs Go. `dest` doit être sur
 * le même volume que le dossier de ROMs final pour que le renommage qui suit (hors de cette fonction) soit instantané.
 */
export async function hashAndCopyFile(src: string, dest: string, onBytes?: (bytes: number) => void): Promise<FileHash> {
  const sha = createHash('sha1')
  let crc = 0
  let size = 0
  await pipeline(
    createReadStream(src, { highWaterMark: 4 << 20 }),
    async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        sha.update(chunk)
        crc = crc32(chunk, crc)
        size += chunk.length
        onBytes?.(size)
        yield chunk
      }
    },
    createWriteStream(dest)
  )
  return { crc: hex8(crc), sha1: sha.digest('hex'), size }
}

export interface ZipInfo { name: string; crc: string; size: number }
interface ZipEntry extends ZipInfo { compSize: number; method: number; localOffset: number }

/** Répertoire central d'un zip : nom, CRC32, taille (et de quoi extraire au besoin), sans rien décompresser. Null si illisible. */
async function centralDirectory(path: string): Promise<ZipEntry[] | null> {
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
    const out: ZipEntry[] = []
    let p = 0
    for (let n = 0; n < count && p + 46 <= cdSize; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return null
      const method = cd.readUInt16LE(p + 10)
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      const localOffset = cd.readUInt32LE(p + 42)
      if (!name.endsWith('/')) out.push({ name, crc: hex8(cd.readUInt32LE(p + 16)), compSize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), method, localOffset })
      p += 46 + nameLen + extraLen + commentLen
    }
    return out
  } finally { await fh.close() }
}

/**
 * Contenu d'une archive zip lu dans son répertoire central : nom, CRC32 et taille de chaque fichier, sans rien décompresser.
 * Renvoie null si le fichier n'est pas un zip lisible.
 */
export async function readZip(path: string): Promise<ZipInfo[] | null> {
  const cd = await centralDirectory(path)
  return cd && cd.map(({ name, crc, size }) => ({ name, crc, size }))
}

/** Décalage des données d'une entrée : l'en-tête local a ses propres longueurs de nom/extra (pas forcément celles du répertoire central). */
async function localDataOffset(path: string, localOffset: number): Promise<number> {
  const fh = await open(path, 'r')
  try {
    const head = Buffer.alloc(30)
    await fh.read(head, 0, 30, localOffset)
    if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('en-tête locale de zip invalide')
    return localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  } finally { await fh.close() }
}

/** Lit une petite entrée entièrement en mémoire (feuille .cue : quelques Ko). Null si illisible ou méthode non gérée. */
export async function readZipEntryText(path: string, name: string): Promise<string | null> {
  const entries = await centralDirectory(path)
  const e = entries?.find((x) => x.name === name)
  if (!e || (e.method !== 0 && e.method !== 8)) return null
  try {
    const dataOffset = await localDataOffset(path, e.localOffset)
    const fh = await open(path, 'r')
    try {
      const comp = Buffer.alloc(e.compSize)
      await fh.read(comp, 0, e.compSize, dataOffset)
      return (e.method === 8 ? inflateRawSync(comp) : comp).toString('latin1')
    } finally { await fh.close() }
  } catch { return null }
}

/** Extrait une entrée vers un fichier, en flux (stocké ou déflaté). Faux si la méthode de compression n'est pas gérée. */
async function extractEntryTo(path: string, e: ZipEntry, destPath: string): Promise<boolean> {
  if (e.method !== 0 && e.method !== 8) return false
  const dataOffset = await localDataOffset(path, e.localOffset)
  const src = createReadStream(path, { start: dataOffset, end: dataOffset + e.compSize - 1 })
  const dest = createWriteStream(destPath)
  if (e.method === 8) await pipeline(src, createInflateRaw(), dest)
  else await pipeline(src, dest)
  return true
}

/**
 * Extrait plusieurs entrées d'un zip (ex. une feuille .cue et ses pistes) vers des chemins de destination choisis par l'appelant.
 * Tout ou rien : renvoie false (sans lever) si l'archive, une entrée ou sa méthode de compression posent problème.
 */
/** Les `bytes` premiers octets d'une entrée d'archive, sans extraire le fichier (assez pour un en-tête de jeu) ; null si illisible. */
export async function readZipEntryHead(path: string, name: string, bytes: number): Promise<Buffer | null> {
  const entries = await centralDirectory(path)
  const e = entries?.find((x) => x.name === name)
  if (!e || (e.method !== 0 && e.method !== 8)) return null
  try {
    const dataOffset = await localDataOffset(path, e.localOffset)
    const fh = await open(path, 'r')
    try {
      // Déflate peut se lire tronqué : on prend assez d'octets compressés (jamais plus que le fichier) et on garde ce qui est sorti.
      const want = Math.min(e.compSize, e.method === 8 ? bytes * 2 + 4096 : bytes)
      const comp = Buffer.alloc(want)
      await fh.read(comp, 0, want, dataOffset)
      return (e.method === 8 ? inflateRawSync(comp, { finishFlush: constants.Z_SYNC_FLUSH }) : comp).subarray(0, bytes)
    } finally { await fh.close() }
  } catch { return null }
}
export async function extractZipEntries(path: string, mapping: readonly { entry: string; dest: string }[]): Promise<boolean> {
  const entries = await centralDirectory(path)
  if (!entries) return false
  for (const { entry, dest } of mapping) {
    const e = entries.find((x) => x.name === entry)
    if (!e) return false
    const ok = await extractEntryTo(path, e, dest).catch(() => false)
    if (!ok) return false
  }
  return true
}
