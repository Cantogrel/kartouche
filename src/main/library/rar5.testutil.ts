import { crc32 } from 'node:zlib'

/**
 * Écrivain RAR5 minimal pour les tests (aucun compresseur RAR n'existe hors WinRAR, propriétaire) : entrées STOCKÉES
 * (méthode 0), éventuellement marquées chiffrées, et archives découpées en volumes. Suffisant pour exercer la lecture
 * 7-Zip sans fixture binaire versionnée.
 */
const vint = (n: number): Buffer => {
  const out: number[] = []
  let v = n
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128) }
  out.push(v)
  return Buffer.from(out)
}
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }

/** Bloc : CRC32, taille de l'en-tête, puis l'en-tête (type, drapeaux, champs). */
function block(type: number, flags: number, fields: Buffer, extra?: Buffer, data?: Buffer): Buffer {
  const f = flags | (extra ? 0x1 : 0) | (data ? 0x2 : 0)
  const body = Buffer.concat([vint(type), vint(f), ...(extra ? [vint(extra.length)] : []), ...(data ? [vint(data.length)] : []), fields, ...(extra ? [extra] : [])])
  const size = vint(body.length)
  return Buffer.concat([u32(crc32(Buffer.concat([size, body]))), size, body, ...(data ? [data] : [])])
}

const SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])

export interface Rar5Entry {
  name: string
  data: Buffer
  /** Marque l'entrée comme chiffrée (enregistrement de chiffrement dans la zone « extra »). */
  encrypted?: boolean
}

function fileBlock(e: Rar5Entry, total: number, part: Buffer, split: { before: boolean; after: boolean }, withCrc: boolean): Buffer {
  const name = Buffer.from(e.name, 'utf8')
  const fileFlags = withCrc ? 0x4 : 0
  const fields = Buffer.concat([
    vint(fileFlags), vint(total), vint(0x20), ...(withCrc ? [u32(crc32(e.data))] : []),
    vint(0), // méthode 0 (stocké), version 0
    vint(1), vint(name.length), name
  ])
  const extra = e.encrypted
    ? Buffer.concat([vint(1 + 1 + 1 + 1 + 16 + 16), vint(1), vint(0), vint(0), Buffer.from([15]), Buffer.alloc(16, 1), Buffer.alloc(16, 2)])
    : undefined
  return block(2, (split.before ? 0x8 : 0) | (split.after ? 0x10 : 0), fields, extra, part)
}

/** Archive RAR5 en un seul fichier. */
export function makeRar5(entries: Rar5Entry[]): Buffer {
  return Buffer.concat([
    SIGNATURE,
    block(1, 0, vint(0)),
    ...entries.map((e) => fileBlock(e, e.data.length, e.data, { before: false, after: false }, true)),
    block(5, 0, vint(0))
  ])
}

/** Une entrée unique découpée en `parts` volumes (game.part1.rar, game.part2.rar…). */
export function makeRar5Volumes(e: Rar5Entry, parts: number): Buffer[] {
  const size = Math.ceil(e.data.length / parts)
  return Array.from({ length: parts }, (_, i) => {
    const part = e.data.subarray(i * size, (i + 1) * size)
    const last = i === parts - 1
    return Buffer.concat([
      SIGNATURE,
      block(1, 0, Buffer.concat([vint(i === 0 ? 0x1 : 0x3), ...(i === 0 ? [] : [vint(i)])])),
      fileBlock(e, e.data.length, part, { before: i > 0, after: !last }, last),
      block(5, 0, vint(last ? 0 : 0x1))
    ])
  })
}
