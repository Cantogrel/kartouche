import { createCipheriv, createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'
import type { UnpackedArchive } from './archive'

/**
 * Décompression d'un .nsz (NSP compressé, format du projet « nsz » : https://github.com/nicoboss/nsz) en .nsp, sans outil externe ni clé : Eden ne lit pas les .nsz.
 *
 * Un .nsz est un conteneur PFS0 dont les NCA volumineux sont remplacés par des .ncz : l'en-tête NCA d'origine (0x4000 octets, copié tel quel), puis une table de sections
 * « NCZSECTN » (par section : décalage, taille, type de chiffrement, clé AES et compteur), puis le reste de l'NCA DÉCHIFFRÉ et compressé en zstd — soit d'un seul flux
 * (« solid »), soit en blocs indépendants précédés d'un en-tête « NCZBLOCK ». Décompresser puis rechiffrer chaque section en AES-128-CTR (compteur = 8 octets de la table
 * + numéro de bloc de 16 octets, big-endian) redonne l'NCA d'origine octet pour octet. Les autres fichiers (.cnmt.nca, .tik, .cert, .xml) ne sont pas compressés.
 *
 * Vérification : le nom d'un NCA est le début (128 bits) du SHA-256 de son contenu. Chaque NCA reconstitué est comparé à son nom, donc tout flux corrompu, tronqué ou mal
 * rechiffré est refusé au lieu de produire un .nsp inutilisable.
 */

const NCA_HEADER = 0x4000
const SECTION_ENTRY = 0x40
const MAX_SECTIONS = 4096
const MAX_BLOCKS = 1 << 24

interface PfsEntry { name: string; offset: number; size: number }
interface Section { offset: number; size: number; cryptoType: number; key: Buffer; counter: Buffer }
interface Ncz { entry: PfsEntry; ncaSize: number; sections: Section[]; block: { sizeExp: number; list: number[]; dataStart: number } | null; solidStart: number }

export const isNsz = (p: string): boolean => extname(p).toLowerCase() === '.nsz'

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const { bytesRead } = await fh.read(b, got, len - got, pos + got)
    if (bytesRead === 0) throw new Error('fichier .nsz tronqué')
    got += bytesRead
  }
  return b
}

async function readPfs0(fh: FileHandle): Promise<PfsEntry[]> {
  const head = await readAt(fh, 0, 16)
  if (head.toString('latin1', 0, 4) !== 'PFS0') throw new Error('pas un conteneur NSP/NSZ')
  const n = head.readUInt32LE(4), strSize = head.readUInt32LE(8)
  if (n === 0 || n > 4096 || strSize > 1 << 20) throw new Error('en-tête NSZ invalide')
  const table = await readAt(fh, 16, n * 24 + strSize)
  const base = 16 + n * 24 + strSize
  const out: PfsEntry[] = []
  for (let i = 0; i < n; i++) {
    const o = i * 24
    const nameOff = table.readUInt32LE(o + 16)
    const end = table.indexOf(0, n * 24 + nameOff)
    if (nameOff >= strSize || end < 0) throw new Error('en-tête NSZ invalide')
    out.push({ name: table.toString('utf8', n * 24 + nameOff, end), offset: base + Number(table.readBigUInt64LE(o)), size: Number(table.readBigUInt64LE(o + 8)) })
  }
  return out
}

/** En-tête d'un .ncz : sections de chiffrement, mode (solid/blocs) et début des données compressées. */
async function readNcz(fh: FileHandle, entry: PfsEntry): Promise<Ncz> {
  if (entry.size < NCA_HEADER + 16) throw new Error(`${entry.name} : fichier .ncz trop court`)
  const head = await readAt(fh, entry.offset + NCA_HEADER, 16)
  if (head.toString('latin1', 0, 8) !== 'NCZSECTN') throw new Error(`${entry.name} : format .ncz non reconnu`)
  const count = Number(head.readBigUInt64LE(8))
  if (count < 1 || count > MAX_SECTIONS) throw new Error(`${entry.name} : table de sections invalide`)
  const table = await readAt(fh, entry.offset + NCA_HEADER + 16, count * SECTION_ENTRY)
  const sections: Section[] = []
  for (let i = 0; i < count; i++) {
    const o = i * SECTION_ENTRY
    sections.push({
      offset: Number(table.readBigUInt64LE(o)), size: Number(table.readBigUInt64LE(o + 8)), cryptoType: Number(table.readBigUInt64LE(o + 16)),
      key: Buffer.from(table.subarray(o + 32, o + 48)), counter: Buffer.from(table.subarray(o + 48, o + 64))
    })
  }
  // Les sections doivent se suivre sans trou ni recouvrement à partir de la fin de l'en-tête : l'NCA est alors exactement « en-tête + sections ».
  let pos = NCA_HEADER
  for (const s of sections) {
    if (s.offset !== pos || s.size <= 0 || s.size > 2 ** 45) throw new Error(`${entry.name} : sections incohérentes`)
    pos += s.size
  }
  const after = NCA_HEADER + 16 + count * SECTION_ENTRY
  let block: Ncz['block'] = null
  let solidStart = entry.offset + after
  const mark = await readAt(fh, entry.offset + after, Math.min(8, entry.size - after)).catch(() => Buffer.alloc(0))
  if (mark.toString('latin1', 0, 8) === 'NCZBLOCK') {
    const h = await readAt(fh, entry.offset + after, 24)
    const nBlocks = h.readUInt32LE(12)
    const sizeExp = h[11]
    if (h[8] !== 2 || h[9] !== 1 || sizeExp < 14 || sizeExp > 32 || nBlocks < 1 || nBlocks > MAX_BLOCKS) throw new Error(`${entry.name} : en-tête de blocs non pris en charge`)
    const raw = await readAt(fh, entry.offset + after + 24, nBlocks * 4)
    const list = Array.from({ length: nBlocks }, (_, i) => raw.readUInt32LE(i * 4))
    block = { sizeExp, list, dataStart: entry.offset + after + 24 + nBlocks * 4 }
    solidStart = block.dataStart
  }
  return { entry, ncaSize: pos, sections, block, solidStart }
}

/** Rechiffre au fil de l'eau le contenu décompressé d'un .ncz (section par section) ; renvoie les octets de l'NCA d'origine. */
class Reencryptor {
  pos = NCA_HEADER
  private idx = 0
  private cipher: ReturnType<typeof createCipheriv> | null = null
  constructor(private readonly sections: Section[], private readonly total: number) {}

  push(chunk: Buffer): Buffer {
    if (this.pos + chunk.length > this.total) throw new Error('flux décompressé plus long que prévu')
    const out = Buffer.allocUnsafe(chunk.length)
    let done = 0
    while (done < chunk.length) {
      const s = this.sections[this.idx]
      const room = Math.min(chunk.length - done, s.offset + s.size - this.pos)
      const part = chunk.subarray(done, done + room)
      if (s.cryptoType === 3 || s.cryptoType === 4) {
        if (!this.cipher) {
          const iv = Buffer.alloc(16)
          s.counter.copy(iv, 0, 0, 8)
          iv.writeBigUInt64BE(BigInt(Math.floor(this.pos / 16)), 8)
          this.cipher = createCipheriv('aes-128-ctr', s.key, iv)
          const lead = this.pos % 16
          if (lead) this.cipher.update(Buffer.alloc(lead))
        }
        this.cipher.update(part).copy(out, done)
      } else part.copy(out, done)
      done += room
      this.pos += room
      if (this.pos === s.offset + s.size) { this.idx++; this.cipher = null }
    }
    return out
  }
}

const hexName = (name: string): string | null => /^([0-9a-f]{32})(?:\.cnmt)?\.nca$/i.exec(name)?.[1].toLowerCase() ?? null

/** Écrit tout `buf` à la suite (`position` null = fin courante). */
async function append(out: FileHandle, buf: Buffer): Promise<void> {
  let off = 0
  while (off < buf.length) off += (await out.write(buf, off, buf.length - off, null)).bytesWritten
}

/**
 * Décompresse `src` (.nsz) en `dest` (.nsp). `dest` est écrit au fur et à mesure ; en cas d'erreur il est supprimé. L'appelant fournit un chemin dans un dossier temporaire.
 */
export async function decompressNsz(src: string, dest: string, onProgress: (done: number, total: number) => void = () => undefined): Promise<void> {
  const fh = await open(src, 'r')
  let out: FileHandle | null = null
  try {
    const entries = await readPfs0(fh)
    const nczs = new Map<string, Ncz>()
    for (const e of entries) if (/\.ncz$/i.test(e.name)) nczs.set(e.name, await readNcz(fh, e))
    const planned = entries.map((e) => {
      const ncz = nczs.get(e.name)
      return { e, ncz, name: ncz ? e.name.replace(/\.ncz$/i, '.nca') : e.name, size: ncz ? ncz.ncaSize : e.size }
    })

    // En-tête PFS0 du .nsp : mêmes fichiers (les .ncz deviennent des .nca), décalages recalculés, table de noms complétée à un multiple de 0x20 avec l'en-tête.
    const names = planned.map((p) => Buffer.from(`${p.name}\0`, 'utf8'))
    const strBytes = names.reduce((n, b) => n + b.length, 0)
    const strSize = Math.ceil((16 + planned.length * 24 + strBytes) / 0x20) * 0x20 - (16 + planned.length * 24)
    const head = Buffer.alloc(16 + planned.length * 24 + strSize)
    head.write('PFS0', 0, 'latin1')
    head.writeUInt32LE(planned.length, 4)
    head.writeUInt32LE(strSize, 8)
    let dataOff = 0, nameOff = 0
    planned.forEach((p, i) => {
      head.writeBigUInt64LE(BigInt(dataOff), 16 + i * 24)
      head.writeBigUInt64LE(BigInt(p.size), 16 + i * 24 + 8)
      head.writeUInt32LE(nameOff, 16 + i * 24 + 16)
      names[i].copy(head, 16 + planned.length * 24 + nameOff)
      dataOff += p.size
      nameOff += names[i].length
    })
    const total = head.length + dataOff
    await mkdir(join(dest, '..'), { recursive: true })
    out = await open(dest, 'w')
    await append(out, head)
    let written = head.length
    const tick = (n: number): void => { written += n; onProgress(written, total) }

    for (const p of planned) {
      if (!p.ncz) {
        // Fichier non compressé : copié par morceaux.
        for (let off = 0; off < p.e.size; off += 8 << 20) { const part = await readAt(fh, p.e.offset + off, Math.min(8 << 20, p.e.size - off)); await append(out, part); tick(part.length) }
        continue
      }
      const ncz = p.ncz
      const hash = createHash('sha256')
      const header = await readAt(fh, ncz.entry.offset, NCA_HEADER)
      hash.update(header)
      await append(out, header)
      tick(header.length)
      const enc = new Reencryptor(ncz.sections, ncz.ncaSize)
      const emit = async (plain: Buffer): Promise<void> => { const b = enc.push(plain); hash.update(b); await append(out!, b); tick(b.length) }
      const end = ncz.entry.offset + ncz.entry.size
      if (ncz.block) {
        const blockSize = 2 ** ncz.block.sizeExp
        const decompressed = ncz.ncaSize - NCA_HEADER
        let at = ncz.block.dataStart
        for (let i = 0; i < ncz.block.list.length; i++) {
          const cs = ncz.block.list[i]
          const want = Math.min(blockSize, decompressed - i * blockSize)
          if (want <= 0 || at + cs > end) throw new Error(`${p.e.name} : blocs incohérents`)
          const raw = await readAt(fh, at, cs)
          at += cs
          // Un bloc dont la taille compressée égale la taille du bloc est stocké tel quel.
          const plain = cs === want ? raw : zstdDecompressSync(raw)
          if (plain.length !== want) throw new Error(`${p.e.name} : bloc ${i} de taille inattendue`)
          await emit(plain)
        }
      } else {
        const stream = pipeline(createReadStream(src, { start: ncz.solidStart, end: end - 1, highWaterMark: 4 << 20 }), createZstdDecompress(), () => undefined)
        for await (const chunk of stream) await emit(chunk as Buffer)
      }
      if (enc.pos !== ncz.ncaSize) throw new Error(`${p.e.name} : flux compressé incomplet`)
      const want = hexName(p.name)
      if (want && hash.digest('hex').slice(0, 32) !== want) throw new Error(`${p.e.name} : contenu invalide après décompression (empreinte différente du nom)`)
    }
  } catch (e) {
    await out?.close().catch(() => undefined)
    out = null
    await rm(dest, { force: true }).catch(() => undefined)
    throw e
  } finally {
    await out?.close().catch(() => undefined)
    await fh.close().catch(() => undefined)
  }
}

/** Même contrat que `unpackArchive` : décompresse dans `workDir/content` ; le .nsp obtenu est ensuite importé comme un .nsp ordinaire. */
export async function unpackNsz(src: string, workDir: string, onProgress?: (done: number, total: number) => void): Promise<UnpackedArchive | string> {
  if (!existsSync(src)) return 'fichier .nsz introuvable'
  const dest = join(workDir, 'content', `${basename(src, extname(src))}.nsp`)
  try {
    await decompressNsz(src, dest, onProgress)
    return { file: dest, volumes: [src] }
  } catch (e) {
    return `.nsz illisible : ${(e as Error).message}`
  }
}
