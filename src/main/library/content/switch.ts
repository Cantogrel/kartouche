import { open, type FileHandle } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { basename } from 'node:path'
import { classifySwitchTitleId, switchContentFromFilename } from '../switchContent'
import type { ContentInfo, ContentKind, ProbeContext } from './types'

// Lecture des métadonnées d'un NSP Switch, dans l'ordre de fiabilité décroissante :
//   1. le CNMT du NCA de métadonnées (ce qu'Eden lui-même lit : type, Title ID, version, jeu parent), déchiffré avec prod.keys ;
//   2. le `.cnmt.xml` de nxdumptool (même contenu en clair, absent de beaucoup de dumps) ;
//   3. le Title ID (Rights ID) du ticket `.tik` (absent des dumps « sans ticket » et des jeux de base en cartouche) ;
//   4. le Title ID entre crochets dans le NOM du fichier (dernier recours, repère le plus faible).
// Deux sources qui se contredisent ne sont jamais départagées : le contenu est alors « inconnu » et n'est ni importé ni rattaché.

export interface Pfs0Entry { name: string; offset: number; size: number }

/**
 * Un NSP qui est un titre Switch contient des NCA (`<id>.nca`). Un « .nsp » sans aucun NCA est un autre PFS0 : partition ExeFS d'un module système
 * (`main`, `main.npdm`, ex. emuiibo), jamais un jeu ni un contenu à installer.
 */
export const isTitleContainer = (entries: readonly Pfs0Entry[]): boolean => entries.some((e) => e.name.toLowerCase().endsWith('.nca'))
export const NOT_A_TITLE = 'pas un jeu ni un contenu Switch (aucun NCA : module système ou ExeFS)'

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, pos)
  return bytesRead === len ? buf : buf.subarray(0, bytesRead)
}

/** Table des fichiers d'un conteneur PFS0 (NSP, ou partition interne d'un NCA) ; `offset` est absolu dans le tampon/fichier lu. */
export function parsePfs0(head: Buffer): Pfs0Entry[] | null {
  if (head.length < 16 || head.toString('latin1', 0, 4) !== 'PFS0') return null
  const count = head.readUInt32LE(4)
  const strSize = head.readUInt32LE(8)
  if (count > 4096 || head.length < 16 + count * 24 + strSize) return null
  const dataStart = 16 + count * 24 + strSize
  const strings = head.subarray(16 + count * 24, dataStart)
  const out: Pfs0Entry[] = []
  for (let i = 0; i < count; i++) {
    const at = 16 + i * 24
    const nameOff = head.readUInt32LE(at + 16)
    const end = strings.indexOf(0, nameOff)
    out.push({ name: strings.toString('utf8', nameOff, end < 0 ? strings.length : end), offset: dataStart + Number(head.readBigUInt64LE(at)), size: Number(head.readBigUInt64LE(at + 8)) })
  }
  return out
}

async function readPfs0(fh: FileHandle): Promise<Pfs0Entry[] | null> {
  const first = await readAt(fh, 0, 16)
  if (first.length < 16 || first.toString('latin1', 0, 4) !== 'PFS0') return null
  const count = first.readUInt32LE(4)
  const strSize = first.readUInt32LE(8)
  if (count > 4096 || strSize > 1 << 20) return null
  return parsePfs0(await readAt(fh, 0, 16 + count * 24 + strSize))
}

// --- Clés --------------------------------------------------------------------------------------------------------------

/** `prod.keys` : une clé par ligne, `nom = hexa`. */
export function parseKeys(text: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w]+)\s*=\s*([0-9a-fA-F]+)\s*$/.exec(line)
    if (m) keys.set(m[1].toLowerCase(), Buffer.from(m[2], 'hex'))
  }
  return keys
}

const keyCache = new Map<string, { mtime: number; keys: Map<string, Buffer> }>()
async function loadKeys(file: string | undefined): Promise<Map<string, Buffer> | null> {
  if (!file || !existsSync(file)) return null
  const fh = await open(file, 'r')
  try {
    const st = await fh.stat()
    const hit = keyCache.get(file)
    if (hit && hit.mtime === st.mtimeMs) return hit.keys
    const keys = parseKeys((await fh.readFile()).toString('latin1'))
    keyCache.set(file, { mtime: st.mtimeMs, keys })
    return keys
  } finally { await fh.close() }
}

// --- NCA de métadonnées -------------------------------------------------------------------------------------------------

const aes = (mode: 'aes-128-ecb' | 'aes-128-ctr', key: Buffer, iv: Buffer | null, data: Buffer): Buffer => {
  const d = createDecipheriv(mode, key, iv)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(data), d.final()])
}

/** En-tête NCA : AES-128-XTS (variante Nintendo : le « tweak » est le numéro de secteur de 0x200 octets, en big-endian). */
function decryptNcaHeader(raw: Buffer, headerKey: Buffer): Buffer {
  const out: Buffer[] = []
  for (let s = 0; s < raw.length / 0x200; s++) {
    const tweak = Buffer.alloc(16)
    tweak.writeUInt32BE(s, 12)
    const d = createDecipheriv('aes-128-xts', headerKey, tweak)
    d.setAutoPadding(false)
    out.push(Buffer.concat([d.update(raw.subarray(s * 0x200, (s + 1) * 0x200)), d.final()]))
  }
  return Buffer.concat(out)
}

export interface Cnmt {
  /** 0x80 jeu, 0x81 mise à jour, 0x82 DLC (autres : système, delta). */
  type: number
  titleId: string
  version: number
  /** Jeu parent déclaré par le CNMT (mise à jour et DLC). */
  applicationId: string | null
}

const hex64 = (b: Buffer, at: number): string => b.readBigUInt64LE(at).toString(16).padStart(16, '0').toUpperCase()

/** Octets d'un CNMT (en-tête 0x20 puis en-tête étendu : jeu → patch_id, mise à jour/DLC → application_id en premier champ). */
export function parseCnmt(b: Buffer): Cnmt | null {
  if (b.length < 0x20) return null
  const type = b.readUInt8(0x0c)
  const ext = b.readUInt16LE(0x0e)
  const applicationId = (type === 0x81 || type === 0x82) && ext >= 8 && b.length >= 0x28 ? hex64(b, 0x20) : null
  return { type, titleId: hex64(b, 0), version: b.readUInt32LE(8), applicationId }
}

/** CNMT d'un NCA de métadonnées (section 0 : PFS0 contenant `<type>_<titleid>.cnmt`) ; null si une clé manque ou si le format est inattendu. */
export async function cnmtFromMetaNca(nca: Buffer, keys: Map<string, Buffer>): Promise<Cnmt | null> {
  const headerKey = keys.get('header_key')
  if (!headerKey || headerKey.length !== 32 || nca.length < 0xc00) return null
  const h = decryptNcaHeader(nca.subarray(0, 0xc00), headerKey)
  if (h.toString('latin1', 0x200, 0x204) !== 'NCA3' || h.readUInt8(0x205) !== 1) return null
  const gen = Math.max(h.readUInt8(0x206), h.readUInt8(0x220))
  const kaekName = ['application', 'ocean', 'system'][h.readUInt8(0x207)]
  const kaek = kaekName ? keys.get(`key_area_key_${kaekName}_${(gen === 0 ? 0 : gen - 1).toString(16).padStart(2, '0')}`) : undefined
  if (!kaek || kaek.length !== 16) return null
  const key = aes('aes-128-ecb', kaek, null, h.subarray(0x300, 0x340)).subarray(0x20, 0x30)
  const sectionStart = h.readUInt32LE(0x240) * 0x200
  const fs = h.subarray(0x400, 0x600)
  if (fs.readUInt8(2) !== 1 || fs.readUInt8(3) !== 2) return null // PFS0 + SHA-256 hiérarchique : le format des NCA de métadonnées
  const pfsOff = sectionStart + Number(fs.readBigUInt64LE(8 + 0x28 + 16))
  const pfsSize = Number(fs.readBigUInt64LE(8 + 0x28 + 24))
  if (pfsSize <= 0 || pfsOff + pfsSize > nca.length) return null
  let plain: Buffer
  const enc = fs.readUInt8(4)
  if (enc === 1) plain = nca.subarray(pfsOff, pfsOff + pfsSize)
  else if (enc === 3) {
    const ctr = Buffer.alloc(16)
    Buffer.from(fs.subarray(0x140, 0x148)).reverse().copy(ctr, 0)
    const aligned = pfsOff - (pfsOff % 16)
    ctr.writeBigUInt64BE(BigInt(aligned) >> 4n, 8)
    plain = aes('aes-128-ctr', key, ctr, nca.subarray(aligned, pfsOff + pfsSize)).subarray(pfsOff - aligned)
  } else return null
  const inner = parsePfs0(plain)
  const entry = inner?.find((e) => e.name.endsWith('.cnmt'))
  return entry ? parseCnmt(plain.subarray(entry.offset, entry.offset + entry.size)) : null
}

// --- Autres sources ---------------------------------------------------------------------------------------------------

/** Rights ID d'un ticket `.tik` : 16 octets à 0x160 du corps du ticket (juste après la signature, dont la taille dépend de son type). */
export function rightsIdFromTicket(tik: Buffer): string | null {
  const sig: Record<number, number> = { 0x010000: 0x200 + 0x3c, 0x010001: 0x100 + 0x3c, 0x010002: 0x3c + 0x40, 0x010003: 0x200 + 0x3c, 0x010004: 0x100 + 0x3c, 0x010005: 0x3c + 0x40 }
  if (tik.length < 4) return null
  const skip = sig[tik.readUInt32LE(0)]
  if (skip === undefined || tik.length < 4 + skip + 0x170) return null
  return tik.subarray(4 + skip + 0x160, 4 + skip + 0x170).toString('hex').toUpperCase()
}

/** Champs utiles d'un `.cnmt.xml` (nxdumptool) : Type, Id, Version, OriginalId (= jeu parent). */
export function parseCnmtXml(xml: string): { type: number; titleId: string; version: number; applicationId: string | null } | null {
  const tag = (n: string): string | null => new RegExp(`<${n}>\\s*(?:0x)?([0-9A-Za-z]+)\\s*</${n}>`).exec(xml)?.[1] ?? null
  const type = { Application: 0x80, Patch: 0x81, AddOnContent: 0x82 }[tag('Type') ?? ''] ?? 0
  const id = tag('Id')
  if (!id || !/^[0-9a-fA-F]{16}$/.test(id)) return null
  const orig = tag('OriginalId')
  return { type, titleId: id.toUpperCase(), version: Number(tag('Version') ?? 0), applicationId: orig && /^[0-9a-fA-F]{16}$/.test(orig) ? orig.toUpperCase() : null }
}

const KIND_OF_TYPE: Record<number, ContentKind> = { 0x80: 'base', 0x81: 'update', 0x82: 'dlc' }

interface Candidate { source: string; kind: ContentKind; titleId: string; version: number | null; parent: string | null }

function fromCnmt(c: Cnmt | { type: number; titleId: string; version: number; applicationId: string | null }, source: string): Candidate | null {
  const kind = KIND_OF_TYPE[c.type]
  return kind ? { source, kind, titleId: c.titleId, version: c.version, parent: c.applicationId } : null
}

/**
 * Identifie un NSP. null = ce n'est pas un conteneur PFS0 lisible (l'appelant retombe sur le comportement d'un jeu ordinaire).
 * `unknown` = lisible mais contradictoire ou hors périmètre (contenu système…) : jamais rattaché.
 */
export async function probeNsp(file: string, ctx: ProbeContext = {}): Promise<ContentInfo | null> {
  const fh = await open(file, 'r')
  try {
    const entries = await readPfs0(fh)
    if (!entries) return null
    const stem0 = basename(file).replace(/\.[^.]+$/, '')
    if (!isTitleContainer(entries)) return { console: 'switch', kind: 'unknown', titleId: '', baseKey: '', version: null, source: 'container', label: cleanLabel(stem0), reason: NOT_A_TITLE }
    const found: Candidate[] = []
    const keys = await loadKeys(ctx.switchKeysFile).catch(() => null)
    const metas = entries.filter((e) => e.name.endsWith('.cnmt.nca') && e.size <= 1 << 20)
    if (keys) for (const m of metas) {
      const c = await cnmtFromMetaNca(await readAt(fh, m.offset, m.size), keys).catch(() => null)
      const cand = c && fromCnmt(c, 'cnmt')
      if (cand) found.push(cand)
    }
    for (const x of entries.filter((e) => e.name.endsWith('.cnmt.xml') && e.size <= 1 << 16)) {
      const c = parseCnmtXml((await readAt(fh, x.offset, x.size)).toString('utf8'))
      const cand = c && fromCnmt(c, 'xml')
      if (cand) found.push(cand)
    }
    for (const t of entries.filter((e) => e.name.endsWith('.tik') && e.size <= 4096)) {
      const rights = rightsIdFromTicket(await readAt(fh, t.offset, t.size))
      const c = rights && classifySwitchTitleId(rights.slice(0, 16))
      if (c) found.push({ source: 'tik', kind: c.kind, titleId: c.titleId, version: null, parent: null })
    }
    const stem = basename(file).replace(/\.[^.]+$/, '')
    if (found.length === 0) {
      // Rien de lisible dans le conteneur : le nom du fichier est alors le seul repère (voir switchContentFromFilename).
      const named = switchContentFromFilename(stem)
      return named && { console: 'switch', kind: named.kind, titleId: named.titleId, baseKey: named.baseTitleId, version: null, source: 'filename', label: cleanLabel(stem) }
    }
    const first = found[0]
    const clash = found.find((f) => f.titleId !== first.titleId)
    if (clash) return { console: 'switch', kind: 'unknown', titleId: first.titleId, baseKey: '', version: null, source: 'container', label: cleanLabel(stem), reason: `identifiants contradictoires (${first.source} ${first.titleId} / ${clash.source} ${clash.titleId})` }
    const byMask = classifySwitchTitleId(first.titleId)
    // Le parent déclaré par le conteneur doit être celui que la règle d'Eden (Title ID de base = ID sans les 13 bits bas) retrouverait : sinon Eden n'appliquerait pas ce contenu.
    const parent = found.map((f) => f.parent).find((p) => p) ?? null
    if (first.kind === 'base') {
      return { console: 'switch', kind: 'base', titleId: first.titleId, baseKey: first.titleId, version: versionOf(found), source: 'container', label: cleanLabel(stem) }
    }
    const baseKey = byMask?.baseTitleId ?? ''
    if (!baseKey || (parent && parent !== baseKey)) {
      return { console: 'switch', kind: 'unknown', titleId: first.titleId, baseKey: '', version: null, source: 'container', label: cleanLabel(stem), reason: 'jeu parent non déterminable de façon fiable' }
    }
    return { console: 'switch', kind: first.kind, titleId: first.titleId, baseKey, version: versionOf(found), source: 'container', label: cleanLabel(stem) }
  } finally { await fh.close() }
}

const versionOf = (found: Candidate[]): string | null => {
  const v = found.find((f) => f.version !== null)?.version
  return v === undefined || v === null ? null : String(v)
}

/** Nom lisible : le nom du fichier sans extension, ni Title ID/version entre crochets. */
export const cleanLabel = (stem: string): string => stem.replace(/\s*[[(][0-9A-Fa-f]{16}[\])]/g, '').replace(/\s*\[v\d+\]/gi, '').replace(/\s{2,}/g, ' ').trim() || stem
