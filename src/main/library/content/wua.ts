import { open, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import { classifyWiiUTitleId } from './wiiu'
import type { ContentInfo } from './types'

// Archive Wii U (.wua, format ZArchive : https://github.com/Exzap/ZArchive, `zarchivecommon.h`) : un pied de page de 144 octets (big-endian) donne la table des fichiers et celle
// des noms, toutes deux NON compressées. Chaque titre y est un dossier racine nommé « <Title ID 16 hex>_v<version> » (Cemu : `TitleInfo::ParseWuaTitleFolderName`). Lire ces noms suffit à savoir
// ce que contient l'archive — jeu, mise à jour, DLC — sans la décompresser.

const FOOTER = 144
const MAGIC = 0x169f52d6
const VERSION = 0x61bf3a01
const TITLE_DIR = /^([0-9a-fA-F]{16})_v(\d+)$/

export interface WuaTitle { titleId: string; version: number }

/** Titres contenus dans une archive .wua ; null si ce n'est pas une archive ZArchive lisible. */
export async function readWuaTitles(path: string): Promise<WuaTitle[] | null> {
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return null
  try {
    const size = (await fh.stat()).size
    if (size < FOOTER) return null
    const f = Buffer.alloc(FOOTER)
    await fh.read(f, 0, FOOTER, size - FOOTER)
    if (f.readUInt32BE(FOOTER - 4) !== MAGIC || f.readUInt32BE(FOOTER - 8) !== VERSION) return null
    const names = { offset: Number(f.readBigUInt64BE(32)), size: Number(f.readBigUInt64BE(40)) }
    const tree = { offset: Number(f.readBigUInt64BE(48)), size: Number(f.readBigUInt64BE(56)) }
    if (tree.size < 16 || names.offset + names.size > size || tree.offset + tree.size > size) return null
    const node = async (i: number): Promise<Buffer | null> => {
      if ((i + 1) * 16 > tree.size) return null
      const b = Buffer.alloc(16)
      return (await fh.read(b, 0, 16, tree.offset + i * 16)).bytesRead === 16 ? b : null
    }
    const root = await node(0)
    if (!root || (root.readUInt32BE(0) & 0x80000000) !== 0) return null // la racine est un dossier
    const start = root.readUInt32BE(4), count = root.readUInt32BE(8)
    if (count > 4096) return null
    const out: WuaTitle[] = []
    for (let i = 0; i < count; i++) {
      const n = await node(start + i)
      if (!n || (n.readUInt32BE(0) & 0x80000000) !== 0) continue // seuls les dossiers racine sont des titres
      const nameOffset = n.readUInt32BE(0) & 0x7fffffff
      const lenByte = Buffer.alloc(2)
      await fh.read(lenByte, 0, 2, names.offset + nameOffset)
      const len = lenByte[0] & 0x80 ? (lenByte[0] & 0x7f) | (lenByte[1] << 7) : lenByte[0]
      const skip = lenByte[0] & 0x80 ? 2 : 1
      if (len === 0 || len > 255 || nameOffset + skip + len > names.size) continue
      const name = Buffer.alloc(len)
      await fh.read(name, 0, len, names.offset + nameOffset + skip)
      const m = TITLE_DIR.exec(name.toString('utf8'))
      if (m) out.push({ titleId: m[1].toUpperCase(), version: Number(m[2]) })
    }
    return out
  } finally { await fh.close() }
}

/** Lecture d'une plage d'octets (fichier local, requête HTTP « Range », pièces d'un torrent…) : `length` octets exactement à partir de `start`. */
export type RangeReader = (start: number, length: number) => Promise<Buffer>

/**
 * Chemins de tous les fichiers d'une archive ZArchive de `size` octets, lue par plages : le pied de page, la table des noms et l'arborescence se trouvent à la FIN du fichier et ne
 * sont pas compressés — on n'a donc jamais besoin de télécharger l'archive entière pour savoir ce qu'elle contient. Null si ce n'est pas une archive lisible.
 */
export async function readWuaFilesFrom(read: RangeReader, size: number, max = 200_000): Promise<string[] | null> {
  if (size < FOOTER) return null
  const f = await read(size - FOOTER, FOOTER)
  if (f.readUInt32BE(FOOTER - 4) !== MAGIC || f.readUInt32BE(FOOTER - 8) !== VERSION) return null
  const names = { offset: Number(f.readBigUInt64BE(32)), size: Number(f.readBigUInt64BE(40)) }
  const tree = { offset: Number(f.readBigUInt64BE(48)), size: Number(f.readBigUInt64BE(56)) }
  if (tree.size < 16 || tree.size > 64 * 1024 * 1024 || names.size > 64 * 1024 * 1024 || names.offset + names.size > size || tree.offset + tree.size > size) return null
  const nb = await read(names.offset, names.size)
  const tb = await read(tree.offset, tree.size)
  const nameAt = (off: number): string => {
    const first = nb[off]
    const len = first & 0x80 ? (first & 0x7f) | (nb[off + 1] << 7) : first
    const skip = first & 0x80 ? 2 : 1
    return off + skip + len <= nb.length ? nb.toString('utf8', off + skip, off + skip + len) : ''
  }
  const out: string[] = []
  const walk = (i: number, path: string, depth: number): void => {
    if (out.length >= max || depth > 64 || (i + 1) * 16 > tb.length) return
    const t = tb.readUInt32BE(i * 16)
    const name = i === 0 ? '' : nameAt(t & 0x7fffffff)
    const p = name ? `${path}/${name}` : path
    if (t & 0x80000000) { out.push(p); return }
    const start = tb.readUInt32BE(i * 16 + 4), count = tb.readUInt32BE(i * 16 + 8)
    for (let k = 0; k < count && out.length < max; k++) walk(start + k, p, depth + 1)
  }
  walk(0, '', 0)
  return out
}

/** Chemins de tous les fichiers d'une archive .wua locale ; null si illisible. */
export async function readWuaFiles(path: string, max = 200_000): Promise<string[] | null> {
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return null
  try {
    const size = (await fh.stat()).size
    return await readWuaFilesFrom((start, length) => readAt(fh, start, length), size, max)
  } catch { return null } finally { await fh.close() }
}

async function readAt(fh: FileHandle, start: number, length: number): Promise<Buffer> {
  const b = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await fh.read(b, got, length - got, start + got)
    if (bytesRead === 0) throw new Error('archive tronquée')
    got += bytesRead
  }
  return b
}

/**
 * Titre Wii (vWii) emballé pour Wii U — « Virtual Console » de l'eShop (Super Mario Galaxy, etc.) : son code Wii U n'est qu'un lanceur (`frisbiiU.rpx`) qui démarre le mode vWii avec le
 * disque Wii (`fw.img`, `rvlt.tik/tmd`, `hif_*.nfs`). Cemu n'émule pas le mode vWii : le jeu reste sur un écran noir. Repère : ces fichiers dans le dossier `code/` d'un titre.
 */
export const isVWiiWrapper = (files: string[]): boolean => files.some((p) => /\/code\/(frisbiiu\.rpx|fw\.img)$/i.test(p))
export const VWII_REASON = 'jeu Wii (vWii) emballé pour Wii U : Cemu ne sait pas l’exécuter (écran noir) — utiliser la version Wii avec Dolphin'

/**
 * Identité d'une archive .wua : un jeu (elle contient un titre de base — éventuellement avec sa mise à jour et ses DLC, que Cemu y trouve tout seul), ou un contenu seul (mise à jour
 * et/ou DLC d'un jeu qui n'y figure pas). Null si l'archive est illisible : elle suit alors le chemin d'une ROM ordinaire.
 */
export async function probeWua(file: string): Promise<ContentInfo | null> {
  const titles = await readWuaTitles(file)
  if (!titles || titles.length === 0) return null
  const label = basename(file).replace(/\.[^.]+$/, '')
  const classified = titles.map((t) => ({ t, c: classifyWiiUTitleId(t.titleId) }))
  const base = classified.find((x) => x.c?.kind === 'base')
  if (base && isVWiiWrapper((await readWuaFiles(file)) ?? [])) return { console: 'wiiu', kind: 'unknown', titleId: base.t.titleId, baseKey: '', version: String(base.t.version), source: 'container', label, reason: VWII_REASON }
  if (base) return { console: 'wiiu', kind: 'base', titleId: base.t.titleId, baseKey: base.c!.baseKey, version: String(base.t.version), source: 'container', label }
  const known = classified.filter((x) => x.c && x.c.kind !== 'unknown')
  const unknown = (reason: string): ContentInfo => ({ console: 'wiiu', kind: 'unknown', titleId: titles[0].titleId, baseKey: '', version: null, source: 'container', label, reason })
  if (known.length === 0 || known.length < classified.length) return unknown('titre Wii U non pris en charge dans cette archive')
  const keys = new Set(known.map((x) => x.c!.baseKey))
  if (keys.size > 1) return unknown('mises à jour/DLC de plusieurs jeux dans une même archive : à séparer avant l’import')
  const update = known.find((x) => x.c!.kind === 'update')
  const pick = update ?? known[0]
  return { console: 'wiiu', kind: pick.c!.kind, titleId: pick.t.titleId, baseKey: pick.c!.baseKey, version: String(pick.t.version), source: 'container', label }
}
