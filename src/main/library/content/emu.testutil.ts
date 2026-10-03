import { createCipheriv } from 'node:crypto'
import { crc32 } from 'node:zlib'

// Fabrique de fichiers SYNTHÉTIQUES pour les formats Sony/Nintendo plus riches que ceux de content.testutil.ts : paquet PS3 complet (table de fichiers chiffrée comme RPCS3 la lit),
// PARAM.SFO, archive Vita, TMD Wii U avec ses contenus. Même avertissement : ils valident l'analyse de RomVault, jamais le comportement d'un émulateur.

const PKG_AES_KEY = Buffer.from('2e7b71d7c9c9a14ea3221f188828b8f8', 'hex')

export interface FullPkgEntry { name: string; data?: Buffer; folder?: boolean; overwrite?: boolean }

/** Paquet PS3 « release » complet : en-tête, métadonnées (type 4 « Game Data », drapeaux), puis données chiffrées en AES-128-CTR (table de 32 octets par fichier, noms, contenus). */
export function makeFullPkg(opt: { serial: string; entries: FullPkgEntry[]; flags?: number; installDir?: string; klicensee?: Buffer }): Buffer {
  const klicensee = opt.klicensee ?? Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
  const n = opt.entries.length
  // Données en clair : table, puis noms, puis contenus (tous alignés sur 16 octets).
  const names = opt.entries.map((e) => Buffer.from(e.name))
  const align = (x: number): number => Math.ceil(x / 16) * 16
  let off = align(n * 32)
  const nameOffsets = names.map((b) => { const o = off; off += align(b.length); return o })
  const fileOffsets = opt.entries.map((e) => { const o = off; off += align(e.data?.length ?? 0) + 16; return o })
  const plain = Buffer.alloc(off)
  opt.entries.forEach((e, i) => {
    const at = i * 32
    plain.writeUInt32BE(nameOffsets[i], at)
    plain.writeUInt32BE(names[i].length, at + 4)
    plain.writeBigUInt64BE(BigInt(fileOffsets[i]), at + 8)
    plain.writeBigUInt64BE(BigInt(e.data?.length ?? 0), at + 0x10)
    plain.writeUInt32BE(((e.folder ? 4 : 3) | (e.overwrite ? 0x80000000 : 0)) >>> 0, at + 0x18)
    names[i].copy(plain, nameOffsets[i])
    e.data?.copy(plain, fileOffsets[i])
  })
  const cipher = createCipheriv('aes-128-ctr', PKG_AES_KEY, klicensee)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  const metaOffset = 0xc0
  const packets: Buffer[] = []
  const pkt = (id: number, body: Buffer): void => { const h = Buffer.alloc(8); h.writeUInt32BE(id, 0); h.writeUInt32BE(body.length, 4); packets.push(h, body) }
  const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); return b }
  pkt(2, u32(4)) // Game Data
  pkt(3, u32(opt.flags ?? 0))
  if (opt.installDir) pkt(0xa, Buffer.concat([Buffer.alloc(8), Buffer.from(`${opt.installDir}\0`)]))
  const meta = Buffer.concat(packets)
  const dataOffset = 0x200
  const head = Buffer.alloc(dataOffset)
  head.writeUInt32LE(0x474b507f, 0)
  head.writeUInt16BE(0x8000, 4)
  head.writeUInt16BE(1, 6)
  head.writeUInt32BE(metaOffset, 8)
  head.writeUInt32BE(opt.installDir ? 3 : 2, 0x0c)
  head.writeUInt32BE(meta.length, 0x10)
  head.writeUInt32BE(n, 0x14)
  head.writeBigUInt64BE(BigInt(dataOffset + data.length), 0x18)
  head.writeBigUInt64BE(BigInt(dataOffset), 0x20)
  head.writeBigUInt64BE(BigInt(data.length), 0x28)
  head.write(`UP9000-${opt.serial}_00-0000000000000001`, 0x30, 'latin1')
  klicensee.copy(head, 0x70)
  meta.copy(head, metaOffset)
  return Buffer.concat([head, data])
}

/** PARAM.SFO minimal (format PSF) : chaînes UTF-8 `clé → valeur`. */
export function makeSfo(values: Record<string, string>): Buffer {
  const keys = Object.keys(values)
  const keyTable = Buffer.concat(keys.map((k) => Buffer.from(`${k}\0`)))
  const dataItems = keys.map((k) => { const v = Buffer.from(`${values[k]}\0`); const pad = Buffer.alloc(Math.ceil(v.length / 4) * 4); v.copy(pad); return pad })
  const keyOff = 20 + keys.length * 16
  const dataOff = Math.ceil((keyOff + keyTable.length) / 4) * 4
  const head = Buffer.alloc(dataOff)
  head.writeUInt32LE(0x46535000, 0)
  head.writeUInt32LE(0x101, 4)
  head.writeUInt32LE(keyOff, 8)
  head.writeUInt32LE(dataOff, 12)
  head.writeUInt32LE(keys.length, 16)
  let kOff = 0, dOff = 0
  keys.forEach((k, i) => {
    const at = 20 + i * 16
    head.writeUInt16LE(kOff, at)
    head.writeUInt16LE(0x0204, at + 2)
    head.writeUInt32LE(Buffer.byteLength(values[k]) + 1, at + 4)
    head.writeUInt32LE(dataItems[i].length, at + 8)
    head.writeUInt32LE(dOff, at + 12)
    kOff += Buffer.byteLength(k) + 1
    dOff += dataItems[i].length
  })
  keyTable.copy(head, keyOff)
  return Buffer.concat([head, ...dataItems])
}

/** Zip à entrées stockées (non compressées) : suffisant pour les lecteurs de RomVault (répertoire central + en-têtes locaux). */
export function makeZipStored(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  for (const { name, data } of files) {
    const nm = Buffer.from(name)
    const crc = crc32(data)
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26)
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(off, 42)
    locals.push(lh, nm, data)
    centrals.push(cd, nm)
    off += lh.length + nm.length + data.length
  }
  const cdBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cdBuf, end])
}

/** Archive de contenu Vita : PARAM.SFO (CATEGORY `gd`/`gp`/`ac`) et fichiers donnés (chemins relatifs à la racine de l'archive). */
export function makeVitaArchive(opt: { category: 'gd' | 'gp' | 'ac'; titleId: string; contentId?: string; version?: string; files?: Record<string, string | Buffer>; root?: string }): Buffer {
  const root = opt.root ?? ''
  const sfo = makeSfo({ CATEGORY: opt.category, TITLE_ID: opt.titleId, CONTENT_ID: opt.contentId ?? `EP0000-${opt.titleId}_00-0000000000000000`, APP_VER: opt.version ?? '01.00' })
  const files = [{ name: `${root}sce_sys/param.sfo`, data: sfo }, ...Object.entries(opt.files ?? {}).map(([name, data]) => ({ name: `${root}${name}`, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }))]
  return makeZipStored(files)
}

/** TMD Wii U (signature RSA-2048 SHA-256) avec ses enregistrements de contenu (id, index, type, taille). */
export function makeWiiUTmd(titleId: string, version: number, contents: { id: number; size?: number; type?: number }[]): Buffer {
  const hdr = 4 + 0x100 + 0x3c
  const start = hdr + 0xc4 + 64 * 0x24
  const tmd = Buffer.alloc(start + contents.length * 0x30)
  tmd.writeUInt32BE(0x010004, 0)
  Buffer.from(titleId, 'hex').copy(tmd, hdr + 0x4c)
  tmd.writeUInt16BE(version, hdr + 0x9c)
  tmd.writeUInt16BE(contents.length, hdr + 0x9e)
  contents.forEach((c, i) => {
    const at = start + i * 0x30
    tmd.writeUInt32BE(c.id, at)
    tmd.writeUInt16BE(i, at + 4)
    tmd.writeUInt16BE(c.type ?? 0x2003, at + 6)
    tmd.writeUInt32BE(0, at + 8)
    tmd.writeUInt32BE(c.size ?? 16, at + 12)
  })
  return tmd
}

/** app.xml / cos.xml minimaux d'un titre Wii U déjà extrait (tels que Cemu les relit). */
export const makeAppXml = (titleId: string, version = 0): string =>
  `<?xml version="1.0" encoding="utf-8"?><app type="complex" access="777"><version type="unsignedInt" length="4">15</version><title_id type="hexBinary" length="8">${titleId}</title_id><title_version type="hexBinary" length="2">${version.toString(16).padStart(4, '0')}</title_version><sdk_version type="unsignedInt" length="4">21213</sdk_version><app_type type="hexBinary" length="4">8000002E</app_type><group_id type="hexBinary" length="4">0000005A</group_id></app>`
export const makeCosXml = (argstr = 'root.rpx'): string => `<?xml version="1.0" encoding="utf-8"?><app type="complex" access="777"><argstr type="string" length="${argstr.length}">${argstr}</argstr></app>`

const align64 = (n: number): number => Math.ceil(n / 0x40) * 0x40

/**
 * .cia à contenu non chiffré, aux structures complètes (en-tête CIA, ticket commun de 0x2AC octets, TMD de 0x9C4 octets + 1 contenu) — le format que `azahar -i` lit (am.cpp, ticket.cpp,
 * title_metadata.cpp). Aucune signature valide, aucun vrai jeu : sert à faire INSTALLER un titre factice par le vrai Azahar.
 */
export function makeInstallableCia(titleId: string, opt: { version?: number; content?: Buffer; ticketId?: bigint } = {}): Buffer {
  const content = opt.content ?? Buffer.from('contenu de test RomVault')
  // Ticket : signature RSA-2048 SHA-256 (0x100 + remplissage jusqu'à 0x140), corps de 0x164 octets, puis index de contenu minimal (u32, taille u32 = 8).
  const ticket = Buffer.alloc(0x140 + 0x164 + 8)
  ticket.writeUInt32BE(0x010004, 0)
  const body = 0x140
  ticket.writeBigUInt64BE(opt.ticketId ?? 0x52564553n, body + 0x90) // ticket_id
  Buffer.from(titleId, 'hex').copy(ticket, body + 0x9c) // title_id
  ticket.writeUInt32BE(0, body + 0x164 + 0) // index de contenu : premier mot
  ticket.writeUInt32BE(8, body + 0x164 + 4) // index de contenu : taille
  // TMD : signature RSA-2048 SHA-256, corps de 0x9C4 octets, un enregistrement de contenu (id 0, index 0, type 0 = non chiffré).
  const tmd = Buffer.alloc(0x140 + 0x9c4 + 0x30)
  tmd.writeUInt32BE(0x010004, 0)
  Buffer.from(titleId, 'hex').copy(tmd, 0x140 + 0x4c)
  tmd.writeUInt16BE(opt.version ?? 0, 0x140 + 0x9c)
  tmd.writeUInt16BE(1, 0x140 + 0x9e) // content_count
  const chunk = 0x140 + 0x9c4
  tmd.writeUInt32BE(0, chunk); tmd.writeUInt16BE(0, chunk + 4); tmd.writeUInt16BE(0, chunk + 6); tmd.writeBigUInt64BE(BigInt(content.length), chunk + 8)
  const cert = Buffer.alloc(0x40)
  const header = Buffer.alloc(align64(0x2020))
  header.writeUInt32LE(0x2020, 0)
  header.writeUInt32LE(cert.length, 8)
  header.writeUInt32LE(ticket.length, 0x0c)
  header.writeUInt32LE(tmd.length, 0x10)
  header.writeUInt32LE(0, 0x14)
  header.writeBigUInt64LE(BigInt(content.length), 0x18)
  header[0x20] = 0x80 // contenu d'index 0 présent
  const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc(align64(b.length) - b.length)])
  return Buffer.concat([header, pad(cert), pad(ticket), pad(tmd), pad(content)])
}

/** Archive .wua (ZArchive) minimale : dossiers racine « <Title ID>_v<version> » sans contenu — suffisant pour lire les titres (table de fichiers et des noms, pied de page de 144 octets). */
export function makeWua(titles: { titleId: string; version: number }[]): Buffer {
  const names = titles.map((t) => Buffer.from(`${t.titleId.toLowerCase()}_v${t.version}`))
  const nameOffsets: number[] = []
  let off = 0
  const nameTable = Buffer.concat(names.map((n) => { nameOffsets.push(off); off += 1 + n.length; return Buffer.concat([Buffer.from([n.length]), n]) }))
  const tree = Buffer.alloc((1 + titles.length) * 16)
  tree.writeUInt32BE(0, 0) // racine : dossier
  tree.writeUInt32BE(1, 4) // premier enfant
  tree.writeUInt32BE(titles.length, 8)
  titles.forEach((_, i) => tree.writeUInt32BE(nameOffsets[i] & 0x7fffffff, (1 + i) * 16))
  const body = Buffer.concat([nameTable, tree])
  const footer = Buffer.alloc(144)
  const section = (at: number, offset: number, size: number): void => { footer.writeBigUInt64BE(BigInt(offset), at); footer.writeBigUInt64BE(BigInt(size), at + 8) }
  section(32, 0, nameTable.length) // noms
  section(48, nameTable.length, tree.length) // table des fichiers
  footer.writeBigUInt64BE(BigInt(body.length + 144), 128)
  footer.writeUInt32BE(0x61bf3a01, 136)
  footer.writeUInt32BE(0x169f52d6, 140)
  return Buffer.concat([body, footer])
}

/** Archive .wua (ZArchive) dont l'arborescence est donnée par chemins de fichiers (« <titre>/code/app.xml »…) : noms et arbre réels, contenu vide (jamais lu par les sondes) ; `lead` octets de données factices avant la table, comme dans une vraie archive. */
export function makeWuaFiles(paths: string[], lead = 0): Buffer {
  interface Node { name: string; kids: Map<string, Node>; file: boolean }
  const root: Node = { name: '', kids: new Map(), file: false }
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean)
    let cur = root
    parts.forEach((part, i) => {
      let n = cur.kids.get(part)
      if (!n) { n = { name: part, kids: new Map(), file: i === parts.length - 1 }; cur.kids.set(part, n) }
      cur = n
    })
  }
  const order: Node[] = [root]
  const index = new Map<Node, number>([[root, 0]])
  const childStart = new Map<Node, number>()
  for (let i = 0; i < order.length; i++) {
    const n = order[i]
    childStart.set(n, order.length)
    for (const k of n.kids.values()) { index.set(k, order.length); order.push(k) }
  }
  const nameOffsets = new Map<Node, number>()
  const parts: Buffer[] = []
  let off = 0
  for (const n of order.slice(1)) {
    const b = Buffer.from(n.name)
    nameOffsets.set(n, off)
    const len = b.length < 0x80 ? Buffer.from([b.length]) : Buffer.from([0x80 | (b.length & 0x7f), b.length >> 7])
    parts.push(len, b)
    off += len.length + b.length
  }
  const nameTable = Buffer.concat(parts)
  const tree = Buffer.alloc(order.length * 16)
  order.forEach((n, i) => {
    if (i === 0) { tree.writeUInt32BE(0, 0) } else tree.writeUInt32BE(((n.file ? 0x80000000 : 0) | nameOffsets.get(n)!) >>> 0, i * 16)
    if (!n.file) { tree.writeUInt32BE(childStart.get(n)! , i * 16 + 4); tree.writeUInt32BE(n.kids.size, i * 16 + 8) }
  })
  const body = Buffer.concat([nameTable, tree])
  const footer = Buffer.alloc(144)
  const section = (at: number, offset: number, size: number): void => { footer.writeBigUInt64BE(BigInt(offset), at); footer.writeBigUInt64BE(BigInt(size), at + 8) }
  section(32, lead, nameTable.length)
  section(48, lead + nameTable.length, tree.length)
  footer.writeBigUInt64BE(BigInt(lead + body.length + 144), 128)
  footer.writeUInt32BE(0x61bf3a01, 136)
  footer.writeUInt32BE(0x169f52d6, 140)
  return Buffer.concat([Buffer.alloc(lead, 7), body, footer])
}
