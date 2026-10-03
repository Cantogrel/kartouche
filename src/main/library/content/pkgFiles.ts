import { createDecipheriv } from 'node:crypto'
import { open, type FileHandle } from 'node:fs/promises'
import { parsePkgHeader } from './pkg'

// Liste exacte des fichiers qu'installerait un paquet PS3 « release » (0x8000), lue comme RPCS3 le fait (rpcs3/Crypto/unpkg.cpp, `package_reader::decrypt`,
// `read_entries`) : les données du paquet sont chiffrées en AES-128-CTR avec la clé publique du format PKG_AES_KEY (key_vault.h de RPCS3) et pour compteur initial
// la valeur « klicensee » de l'en-tête (octets 0x70-0x7F) augmentée de offset/16. Le tout premier bloc de données est la table des fichiers (32 octets par entrée).
// Sert à savoir, pour un contenu installé avant le suivi des fichiers, quels fichiers de `dev_hdd0/game/<dossier>/` viennent de CE paquet.

const PKG_AES_KEY = Buffer.from('2e7b71d7c9c9a14ea3221f188828b8f8', 'hex')
const RELEASE = 0x8000
const MAX_FILES = 200_000
const MAX_NAME = 256
const ENTRY_FOLDER = 4
const ENTRY_FOLDER_ALT = 0x12
const ENTRY_OVERWRITE = 0x80000000

export interface PkgEntry {
  /** Chemin relatif au dossier d'installation, séparateurs « / », sans « / » initial. */
  name: string
  size: number
  folder: boolean
  /** RPCS3 n'écrase un fichier déjà présent que si l'entrée porte ce drapeau. */
  overwrite: boolean
}

export interface PkgListing {
  /** Sous-dossier de `dev_hdd0/game/` où RPCS3 installe ce paquet (métadonnée 0xA, sinon numéro de série). */
  installDir: string
  entries: PkgEntry[]
}

/** Déchiffre `length` octets du paquet commençant à `offset` (relatif au début des données), quel que soit l'alignement. */
async function readDecrypted(fh: FileHandle, dataOffset: number, offset: number, length: number, klicensee: bigint): Promise<Buffer | null> {
  const start = offset - (offset % 16)
  const end = Math.ceil((offset + length) / 16) * 16
  const raw = Buffer.alloc(end - start)
  const { bytesRead } = await fh.read(raw, 0, raw.length, dataOffset + start)
  if (bytesRead < offset - start + length) return null
  const counter = Buffer.alloc(16)
  counter.writeBigUInt64BE(((klicensee + BigInt(start / 16)) >> 64n) & 0xffffffffffffffffn, 0)
  counter.writeBigUInt64BE((klicensee + BigInt(start / 16)) & 0xffffffffffffffffn, 8)
  const d = createDecipheriv('aes-128-ctr', PKG_AES_KEY, counter)
  return Buffer.concat([d.update(raw.subarray(0, bytesRead)), d.final()]).subarray(offset - start, offset - start + length)
}

/** Fichiers d'un paquet PS3 « release » ; null si le paquet n'en est pas un, est d'un autre type (debug, IDU) ou si sa table de fichiers n'est pas cohérente (jamais de supposition). */
export async function listPkgFiles(path: string): Promise<PkgListing | null> {
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return null
  try {
    const head = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(head, 0, head.length, 0)
    const h = parsePkgHeader(head.subarray(0, bytesRead))
    if (!h || h.platform !== 1 || head.readUInt16BE(4) !== RELEASE || bytesRead < 0x80) return null
    const fileCount = head.readUInt32BE(0x14)
    const dataOffset = Number(head.readBigUInt64BE(0x20))
    const klicensee = (head.readBigUInt64BE(0x70) << 64n) | head.readBigUInt64BE(0x78)
    const total = (await fh.stat()).size
    if (fileCount === 0 || fileCount > MAX_FILES || dataOffset <= 0 || dataOffset >= total) return null
    const table = await readDecrypted(fh, dataOffset, 0, fileCount * 32, klicensee)
    if (!table) return null
    const dataSize = total - dataOffset
    const entries: PkgEntry[] = []
    for (let i = 0; i < fileCount; i++) {
      const nameOffset = table.readUInt32BE(i * 32), nameSize = table.readUInt32BE(i * 32 + 4)
      const fileSize = Number(table.readBigUInt64BE(i * 32 + 0x10)), type = table.readUInt32BE(i * 32 + 0x18)
      const fileOffset = Number(table.readBigUInt64BE(i * 32 + 8))
      // Mêmes contrôles d'intégrité que RPCS3 (read_entries) : une table qui ne les passe pas est celle d'un paquet que RPCS3 refuserait aussi.
      if (nameSize === 0 || nameSize > MAX_NAME || nameOffset + nameSize > dataSize || (fileSize && (fileOffset + fileSize > dataSize || nameOffset === fileOffset))) return null
      const raw = await readDecrypted(fh, dataOffset, nameOffset, nameSize, klicensee)
      if (!raw) return null
      const name = raw.toString('utf8').replace(/\0[\s\S]*$/, '').replace(/\\/g, '/').replace(/^\/+/, '')
      // Un nom qui sortirait du dossier d'installation est refusé par RPCS3 : on ne le suit pas non plus.
      if (!name || name.split('/').some((p) => p === '..')) return null
      const kind = type & 0xff
      entries.push({ name, size: fileSize, folder: kind === ENTRY_FOLDER || kind === ENTRY_FOLDER_ALT, overwrite: (type & ENTRY_OVERWRITE) !== 0 })
    }
    const installDir = h.installDir || h.serial
    if (!installDir || !/^[\w.-]+$/.test(installDir)) return null
    return { installDir, entries }
  } finally { await fh.close() }
}
