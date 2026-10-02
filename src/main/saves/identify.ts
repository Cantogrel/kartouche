import type { DatabaseSync } from 'node:sqlite'
import { createDecipheriv } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { ncsdTitleId } from '../emulators/azahar'
import { readPs1Serial } from '../emulators/duckstation'
import { readPs2Game } from '../emulators/pcsx2'
import { readPspDiscId } from '../emulators/ppsspp'
import { readPs3Serial } from '../emulators/rpcs3'
import { readZip, readZipEntryHead } from '../library/hash'
import { switchContentFromFilename } from '../library/switchContent'

/**
 * Identifiant d'un jeu pour retrouver ses sauvegardes. Lu dans le jeu lui-même (jamais deviné d'après son nom) :
 * numéro de série d'un disque PS1/PS2/PS3, identifiant de disque PSP, Title ID (3DS, Switch, Wii U), identifiant de disque GameCube/Wii.
 * Résultat mémorisé dans `library.game_key` : un jeu dont l'archive est lente à ouvrir n'est lu qu'une fois.
 */
export interface KeyedEntry { id: number; console: string; path: string; titleId?: string | null; vitaTitleId?: string | null; gameKey?: string | null }

export interface IdentifyOptions {
  /** Donne un fichier lisible directement pour un jeu archivé (extrait en cache) ; sans lui, seuls les en-têtes d'un .zip sont lus. */
  resolve?: (path: string) => Promise<string | null>
  /** Dossier de Cemu : sa liste de clés (keys.txt) déchiffre la table des partitions d'une image de disque Wii U. */
  cemuDir?: string
}

/** Identifiant de disque (6 caractères, ex. « GZLP01 ») d'un en-tête : en clair au début d'un .iso/.gcm, à 0x200 dans un .wbfs, copié à 0x58 dans un .rvz/.wia. */
export function discIdFromHead(head: Buffer, ext: string): string | null {
  const at: Record<string, number> = { '.iso': 0, '.gcm': 0, '.wbfs': 0x200, '.rvz': 0x58, '.wia': 0x58 }
  const o = at[ext.toLowerCase()]
  if (o === undefined || head.length < o + 6) return null
  const id = head.toString('latin1', o, o + 6)
  return /^[A-Z0-9]{6}$/.test(id) ? id : null
}

/** Premiers octets d'un jeu : le fichier, ou l'unique entrée d'un .zip lue sans l'extraire ; `name` : nom du fichier (celui de l'entrée pour une archive). */
async function head(path: string, bytes: number): Promise<{ data: Buffer; name: string } | null> {
  if (/\.zip$/i.test(path)) {
    const entries = await readZip(path).catch(() => null)
    if (!entries || entries.length !== 1) return null
    const data = await readZipEntryHead(path, entries[0].name, bytes)
    return data && { data, name: entries[0].name }
  }
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return null
  try {
    const b = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(b, 0, bytes, 0)
    return { data: b.subarray(0, bytesRead), name: path }
  } finally { await fh.close() }
}

// --- Wii U ----------------------------------------------------------------------------------------------------------------------------

/** Title ID (16 hex, majuscules) d'un `meta.xml` de Wii U : `<title_id type="hexBinary" length="8">0005000010143600</title_id>`. */
export function titleIdFromMetaXml(xml: string): string | null {
  const m = /<title_id[^>]*>\s*([0-9a-fA-F]{16})\s*<\/title_id>/.exec(xml)
  return m ? m[1].toUpperCase() : null
}

/**
 * Title ID de base d'une table de partitions Wii U déchiffrée : entrées de 0x80 octets à partir de 0x800, dont le nom est « GM » suivi du Title ID
 * (« GM00050000101436000000000 »). Une image peut en porter plusieurs (jeu + applications système) : le jeu est celui de type 00050000.
 */
export function titleIdFromPartitionTable(toc: Buffer): string | null {
  const ids: string[] = []
  for (let o = 0x800; o + 0x80 <= toc.length; o += 0x80) {
    const name = toc.toString('latin1', o, o + 0x19).replace(/\0.*$/s, '')
    if (!name) break
    const m = /^GM([0-9A-Fa-f]{16})/.exec(name)
    if (m) ids.push(m[1].toUpperCase())
  }
  return ids.find((i) => i.startsWith('00050000')) ?? ids[0] ?? null
}

const WUD_TOC_OFFSET = 0x18000
const WUD_TOC_SIZE = 0x8000
const WUD_TOC_MAGIC = 0xcca6e67b

/** Clés de disque candidates : celles de `keys.txt` de Cemu (une par ligne, 32 chiffres hexadécimaux), puis un fichier `.key` voisin du jeu (16 octets bruts ou 32 chiffres). */
async function wiiuKeys(path: string, cemuDir: string | undefined): Promise<Buffer[]> {
  const keys: Buffer[] = []
  const add = (hex: string | undefined): void => { if (hex && /^[0-9a-fA-F]{32}$/.test(hex)) keys.push(Buffer.from(hex, 'hex')) }
  for (const k of [join(dirname(path), `${basename(path, extname(path))}.key`), join(dirname(path), 'game.key')]) {
    const raw = await readFile(k).catch(() => null)
    if (raw?.length === 16) keys.push(raw)
    else if (raw) add(raw.toString('latin1').trim())
  }
  if (cemuDir) for (const line of (await readFile(join(cemuDir, 'keys.txt'), 'latin1').catch(() => '')).split(/\r?\n/)) add(/^\s*([0-9a-fA-F]{32})/.exec(line)?.[1])
  return keys
}

/** Lecteur par décalage d'une image .wud (brute) ou .wux (secteurs dédupliqués : en-tête « WUX0 », index des secteurs, puis les secteurs). */
async function wiiuImageReader(path: string): Promise<{ read: (offset: number, length: number) => Promise<Buffer>; close: () => Promise<void> } | null> {
  const fh = await open(path, 'r')
  if (/\.wud$/i.test(path)) {
    return { read: async (offset, length) => { const b = Buffer.alloc(length); await fh.read(b, 0, length, offset); return b }, close: () => fh.close() }
  }
  const h = Buffer.alloc(0x20)
  await fh.read(h, 0, 0x20, 0)
  if (h.toString('latin1', 0, 4) !== 'WUX0' || h.readUInt32LE(4) !== 0x1099d02e) { await fh.close(); return null }
  const sector = h.readUInt32LE(8), total = Number(h.readBigUInt64LE(16))
  const n = Math.ceil(total / sector)
  const index = Buffer.alloc(n * 4)
  await fh.read(index, 0, index.length, 0x20)
  const dataStart = Math.ceil((0x20 + n * 4) / sector) * sector
  return {
    read: async (offset, length) => {
      const parts: Buffer[] = []
      for (let p = offset; p < offset + length;) {
        const s = Math.floor(p / sector)
        if (s >= n) break
        const b = Buffer.alloc(sector)
        await fh.read(b, 0, sector, dataStart + index.readUInt32LE(s * 4) * sector)
        const from = p - s * sector, take = Math.min(sector - from, offset + length - p)
        parts.push(b.subarray(from, from + take)); p += take
      }
      return Buffer.concat(parts)
    },
    close: () => fh.close()
  }
}

/** Title ID Wii U depuis le jeu : image de disque (.wud/.wux, table de partitions déchiffrée avec les clés connues), archive .wua, ou dossier dumpé (meta/meta.xml). */
export async function readWiiUTitleId(path: string, cemuDir?: string): Promise<string | null> {
  const ext = extname(path).toLowerCase()
  if (ext === '.wud' || ext === '.wux') {
    const img = await wiiuImageReader(path).catch(() => null)
    if (!img) return null
    try {
      const toc = await img.read(WUD_TOC_OFFSET, WUD_TOC_SIZE)
      if (toc.length < WUD_TOC_SIZE) return null
      for (const key of await wiiuKeys(path, cemuDir)) {
        const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16))
        d.setAutoPadding(false)
        const plain = Buffer.concat([d.update(toc), d.final()])
        if (plain.readUInt32BE(0) === WUD_TOC_MAGIC) return titleIdFromPartitionTable(plain)
      }
      return null
    } finally { await img.close() }
  }
  if (ext === '.wua') {
    // Archive de titres : un dossier « <TitleID>_v<version> » par titre (jeu, mise à jour, DLC) ; le jeu est celui de type 00050000.
    const ids = [...new Set((await readZip(path).catch(() => null) ?? []).map((e) => /^([0-9a-fA-F]{16})_v\d+\//.exec(e.name)?.[1]?.toUpperCase()).filter((x): x is string => !!x))]
    return ids.find((i) => i.startsWith('00050000')) ?? null
  }
  // Dossier dumpé : le .rpx est dans code/, le meta.xml dans meta/ (ou à côté si on pointe le dossier du jeu).
  const dir = dirname(path)
  for (const meta of [join(dir, '..', 'meta', 'meta.xml'), join(dir, 'meta', 'meta.xml')]) {
    const id = titleIdFromMetaXml(await readFile(meta, 'latin1').catch(() => ''))
    if (id) return id
  }
  return null
}

// --- Identification -------------------------------------------------------------------------------------------------------------------

/** Lit l'identifiant du jeu dans le jeu lui-même ; null si son format ne le permet pas. */
export async function readGameKey(entry: KeyedEntry, opts: IdentifyOptions = {}): Promise<string | null> {
  if (entry.console === 'switch') {
    // Title ID de la bibliothèque, sinon celui que porte le nom du dump (convention nxdumptool / No-Intro, déjà celle qui classe jeux, mises à jour et DLC à l'import).
    const named = switchContentFromFilename(basename(entry.path))
    return entry.titleId ?? (named?.kind === 'base' && named.titleId ? named.titleId : null)
  }
  if (entry.console === 'vita') return entry.vitaTitleId ?? null
  const file = async (): Promise<string | null> => (/\.zip$/i.test(entry.path) ? (await opts.resolve?.(entry.path)) ?? null : entry.path)
  switch (entry.console) {
    case 'ps1': { const p = await file(); return p && (await readPs1Serial(p).catch(() => null)) }
    case 'ps2': { const p = await file(); return p && ((await readPs2Game(p).catch(() => null))?.serial ?? null) }
    case 'ps3': { const p = await file(); return p && (await readPs3Serial(p).catch(() => null)) }
    case 'psp': { const p = await file(); return p && (await readPspDiscId(p).catch(() => null)) }
    case 'n3ds': {
      const h = await head(entry.path, 0x200).catch(() => null)
      return (h && ncsdTitleId(h.data)) ?? entry.titleId?.toUpperCase() ?? null
    }
    case 'gc': case 'wii': {
      const h = await head(entry.path, 0x210).catch(() => null)
      return h && discIdFromHead(h.data, extname(h.name))
    }
    case 'wiiu': return /\.zip$/i.test(entry.path) ? null : readWiiUTitleId(entry.path, opts.cemuDir).catch(() => null)
    default: return null
  }
}

/** Identifiant déjà mémorisé, sinon lu dans le jeu (et mémorisé). */
export async function identifyGame(db: DatabaseSync, entry: KeyedEntry, opts: IdentifyOptions = {}): Promise<string | null> {
  if (entry.gameKey) return entry.gameKey
  const stored = (db.prepare('SELECT game_key FROM library WHERE id = ?').get(entry.id) as { game_key: string | null } | undefined)?.game_key
  if (stored) return stored
  const key = await readGameKey(entry, opts)
  if (key) db.prepare('UPDATE library SET game_key = ? WHERE id = ?').run(key, entry.id)
  return key
}
