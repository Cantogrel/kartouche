// TMD (Title Metadata) de la famille Nintendo CTR/Cafe : même disposition sur 3DS (.cia) et Wii U (title.tmd) — signature (taille selon son
// type), puis un en-tête fixe dont le Title ID (8 octets big-endian) et la version (u16 big-endian).

const SIG_SIZE: Record<number, number> = { 0x010000: 0x200 + 0x3c, 0x010001: 0x100 + 0x3c, 0x010002: 0x3c + 0x40, 0x010003: 0x200 + 0x3c, 0x010004: 0x100 + 0x3c, 0x010005: 0x3c + 0x40 }

export interface Tmd { titleId: string; version: number }

/** `buf` commence à l'octet 0 du TMD (type de signature). Null si le type de signature est inconnu ou si le tampon est trop court. */
export function parseTmd(buf: Buffer): Tmd | null {
  if (buf.length < 4) return null
  const skip = SIG_SIZE[buf.readUInt32BE(0)]
  if (skip === undefined || buf.length < 4 + skip + 0xa0) return null
  const hdr = 4 + skip
  return { titleId: buf.subarray(hdr + 0x4c, hdr + 0x54).toString('hex').toUpperCase(), version: buf.readUInt16BE(hdr + 0x9c) }
}

/** Taille maximale du TMD qu'on accepte de lire (un TMD réel fait quelques Ko ; 64 Ko borne un fichier corrompu). */
export const TMD_MAX = 64 * 1024

export interface TmdContent { id: number; index: number; type: number; size: number }

/**
 * Contenus d'un TMD Wii U : enregistrements de 0x30 octets (id u32, index u16, type u16, taille u64) après l'en-tête fixe et ses 64 « content info » de 0x24 octets — disposition lue dans
 * Cemu (`ncrypto.cpp`, `TMDParser::parse`). Null si le tampon est trop court pour le nombre de contenus annoncé.
 */
export function parseWiiUTmdContents(buf: Buffer): TmdContent[] | null {
  if (buf.length < 4) return null
  const skip = SIG_SIZE[buf.readUInt32BE(0)]
  if (skip === undefined) return null
  const hdr = 4 + skip
  const count = buf.length >= hdr + 0xa0 ? buf.readUInt16BE(hdr + 0x9e) : 0
  const start = hdr + 0xc4 + 64 * 0x24
  if (count === 0 || buf.length < start + count * 0x30) return null
  const out: TmdContent[] = []
  for (let i = 0; i < count; i++) {
    const at = start + i * 0x30
    out.push({ id: buf.readUInt32BE(at), index: buf.readUInt16BE(at + 4), type: buf.readUInt16BE(at + 6), size: buf.readUInt32BE(at + 8) * 2 ** 32 + buf.readUInt32BE(at + 12) })
  }
  return out
}
