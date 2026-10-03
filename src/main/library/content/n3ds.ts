import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseTmd, TMD_MAX } from './tmd'
import type { ContentInfo, ContentKind } from './types'

// Contenu 3DS : le Title ID (0xCCCCABCDLLLLLLRR, voir 3dbrew « Titles ») porte tout : 00040000 jeu, 0004000E mise à jour (même identifiant bas
// que le jeu), 0004008C DLC. Seuls ces trois préfixes sont reconnus ; démos, DLP, applications système… restent « inconnus » (jamais rattachés).

const KIND_OF_HIGH: Record<string, ContentKind> = { '00040000': 'base', '0004000E': 'update', '0004008C': 'dlc' }

export function classify3dsTitleId(id: string): { kind: ContentKind; baseKey: string } | null {
  const hex = id.toUpperCase()
  if (!/^[0-9A-F]{16}$/.test(hex)) return null
  const kind = KIND_OF_HIGH[hex.slice(0, 8)]
  return kind ? { kind, baseKey: `00040000${hex.slice(8)}` } : null
}

/** Version du TMD au format 3DS « majeur.mineur.micro » (bits 15-10, 9-4, 3-0). */
export const version3ds = (v: number): string => `${v >> 10}.${(v >> 4) & 0x3f}.${v & 0xf}`

const align64 = (n: number): number => Math.ceil(n / 0x40) * 0x40

/** Identifie un .cia : en-tête CIA → sections (certificats, ticket) alignées sur 0x40 → TMD. */
export async function probeCia(file: string): Promise<ContentInfo | null> {
  const fh = await open(file, 'r')
  try {
    const head = Buffer.alloc(0x20)
    if ((await fh.read(head, 0, 0x20, 0)).bytesRead < 0x20) return null
    const headerSize = head.readUInt32LE(0)
    const cert = head.readUInt32LE(8), ticket = head.readUInt32LE(0x0c), tmdSize = head.readUInt32LE(0x10)
    if (headerSize !== 0x2020 || tmdSize < 0x140 || tmdSize > TMD_MAX) return null
    const tmdOff = align64(headerSize) + align64(cert) + align64(ticket)
    const buf = Buffer.alloc(tmdSize)
    if ((await fh.read(buf, 0, tmdSize, tmdOff)).bytesRead < tmdSize) return null
    const tmd = parseTmd(buf)
    if (!tmd) return null
    const stem = basename(file).replace(/\.[^.]+$/, '')
    const c = classify3dsTitleId(tmd.titleId)
    if (!c) return { console: 'n3ds', kind: 'unknown', titleId: tmd.titleId, baseKey: '', version: null, source: 'container', label: stem, reason: `type de contenu 3DS non pris en charge (${tmd.titleId.slice(0, 8)})` }
    return { console: 'n3ds', kind: c.kind, titleId: tmd.titleId, baseKey: c.baseKey, version: version3ds(tmd.version), source: 'container', label: stem }
  } finally { await fh.close() }
}
