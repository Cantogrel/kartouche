// Fabrique de fichiers SYNTHÉTIQUES (NSP, CIA, PKG, dossiers Wii U) pour tester l'analyse, l'identification et le rattachement. Ils respectent la
// disposition des vrais formats (mêmes décalages que ceux lus par switch.ts, n3ds.ts, pkg.ts, wiiu.ts) mais ne contiennent aucun jeu : un test qui s'en sert
// ne prouve JAMAIS qu'un émulateur reconnaît le contenu.

export function makeNsp(files: { name: string; data: Buffer }[]): Buffer {
  const strings = Buffer.concat(files.map((f) => Buffer.from(`${f.name}\0`)))
  const head = Buffer.alloc(16 + files.length * 24 + strings.length)
  head.write('PFS0', 0, 'latin1')
  head.writeUInt32LE(files.length, 4)
  head.writeUInt32LE(strings.length, 8)
  let off = 0
  let nameOff = 0
  files.forEach((f, i) => {
    const at = 16 + i * 24
    head.writeBigUInt64LE(BigInt(off), at)
    head.writeBigUInt64LE(BigInt(f.data.length), at + 8)
    head.writeUInt32LE(nameOff, at + 16)
    off += f.data.length
    nameOff += Buffer.byteLength(f.name) + 1
  })
  strings.copy(head, 16 + files.length * 24)
  return Buffer.concat([head, ...files.map((f) => f.data)])
}

/** Ticket RSA-2048 SHA-256 (0x2C0 octets) dont le Rights ID est `<titleId><16 chiffres>`. */
export function makeTik(titleId: string): Buffer {
  const tik = Buffer.alloc(0x2c0)
  tik.writeUInt32LE(0x010004, 0)
  Buffer.from(`${titleId}${'0'.repeat(15)}b`, 'hex').copy(tik, 0x2a0)
  return tik
}

const CNMT_TYPE = { base: 'Application', update: 'Patch', dlc: 'AddOnContent' } as const

/** `.cnmt.xml` de nxdumptool. */
export function makeCnmtXml(kind: keyof typeof CNMT_TYPE, titleId: string, version = 0, originalId?: string): Buffer {
  return Buffer.from(`<?xml version="1.0"?><ContentMeta><Type>${CNMT_TYPE[kind]}</Type><Id>0x${titleId.toLowerCase()}</Id><Version>${version}</Version>${originalId ? `<OriginalId>0x${originalId.toLowerCase()}</OriginalId>` : ''}</ContentMeta>`)
}

/** NSP identifié par son `.cnmt.xml` (comme beaucoup de dumps nxdumptool). */
export function nspWithXml(kind: keyof typeof CNMT_TYPE, titleId: string, version = 0, originalId?: string, filler = 'x'): Buffer {
  return makeNsp([
    { name: `${titleId.toLowerCase()}.cnmt.xml`, data: makeCnmtXml(kind, titleId, version, originalId) },
    { name: `${titleId.toLowerCase()}.nca`, data: Buffer.from(filler) }
  ])
}

/** NSP identifié par son ticket seulement (aucun XML, pas de clés pour lire le NCA de métadonnées). */
export function nspWithTicket(titleId: string, filler = 'x'): Buffer {
  return makeNsp([
    { name: `${titleId.toLowerCase()}.tik`, data: makeTik(titleId) },
    { name: `${titleId.toLowerCase()}.nca`, data: Buffer.from(filler) }
  ])
}

const align64 = (n: number): number => Math.ceil(n / 0x40) * 0x40

/** TMD minimal (signature RSA-2048 SHA-256) pour `titleId` (16 hex) et `version`. */
export function makeTmd(titleId: string, version = 0): Buffer {
  const tmd = Buffer.alloc(4 + 0x100 + 0x3c + 0xa4)
  tmd.writeUInt32BE(0x010004, 0)
  const hdr = 4 + 0x100 + 0x3c
  Buffer.from(titleId, 'hex').copy(tmd, hdr + 0x4c)
  tmd.writeUInt16BE(version, hdr + 0x9c)
  return tmd
}

/** .cia : en-tête 0x2020, certificats et ticket vides (alignés), TMD, puis un contenu bidon. */
export function makeCia(titleId: string, version = 0): Buffer {
  const tmd = makeTmd(titleId, version)
  const header = Buffer.alloc(align64(0x2020)) // l'en-tête déclare 0x2020 octets mais la section suivante commence au multiple de 0x40
  header.writeUInt32LE(0x2020, 0)
  header.writeUInt32LE(0x40, 8) // certificats
  header.writeUInt32LE(0x40, 0x0c) // ticket
  header.writeUInt32LE(tmd.length, 0x10)
  return Buffer.concat([header, Buffer.alloc(0x40), Buffer.alloc(0x40), tmd, Buffer.alloc(align64(tmd.length) - tmd.length), Buffer.from('content')])
}

/** .pkg Sony : en-tête (octets 0x00-0x6F), identifiant de contenu à 0x30, puis paquets de métadonnées 0x2 (type de contenu) et 0x3 (drapeaux). */
export function makePkg(opt: { platform: 1 | 2; serial: string; contentType: number; flags?: number; region?: string; installDir?: string }): Buffer {
  const buf = Buffer.alloc(0x100)
  buf.writeUInt32LE(0x474b507f, 0)
  buf.writeUInt16BE(0x8000, 4)
  buf.writeUInt16BE(opt.platform, 6)
  buf.writeUInt32BE(0xc0, 8)
  buf.writeUInt32BE(2, 0x0c)
  buf.write(`${opt.region ?? 'UP9000'}-${opt.serial}_00-0000000000000001`, 0x30, 'latin1')
  buf.writeUInt32BE(2, 0xc0); buf.writeUInt32BE(4, 0xc4); buf.writeUInt32BE(opt.contentType, 0xc8)
  buf.writeUInt32BE(3, 0xcc); buf.writeUInt32BE(4, 0xd0); buf.writeUInt32BE(opt.flags ?? 0, 0xd4)
  // Paquet 0xA : dossier d'installation déclaré par le paquet (DLC), précédé de 8 octets que RPCS3 ignore.
  if (opt.installDir) { buf.writeUInt32BE(3, 0x0c); buf.writeUInt32BE(0xa, 0xd8); buf.writeUInt32BE(8 + opt.installDir.length + 1, 0xdc); buf.write(opt.installDir, 0xe8, 'latin1') }
  return buf
}

/** meta.xml d'un titre Wii U déjà déchiffré (« loadiine »). */
export const makeMetaXml = (titleId: string, version = 0): string =>
  `<?xml version="1.0"?><menu><title_version type="unsignedInt" length="4">${version}</title_version><title_id type="hexBinary" length="8">${titleId}</title_id></menu>`
