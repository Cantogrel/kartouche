import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ContentInfo } from './types'

// Paquets .pkg Sony (PS3 et Vita) : en-tête commun, puis paquets de métadonnées (id u32, taille u32, données — big-endian). Même lecture que celle de RPCS3
// (rpcs3/Crypto/unpkg.cpp) : numéro de série du jeu aux octets 55-63 (identifiant de contenu « UP9000-BLUS30443_00-… » commençant à 0x30), type de contenu
// (paquet 0x2) et drapeaux de paquet (paquet 0x3). Aucun déchiffrement : le PARAM.SFO, lui, est chiffré — la catégorie « GD » que RPCS3 relève s'en déduit ici
// du type de contenu « Game Data » (0x04), ce que RPCS3 commente lui-même comme « GameData (also patches) ».

const PKG_FLAG_REQUIRE_LICENSE = 0x04
const PKG_FLAG_PATCH = 0x10
const PLATFORM_PS3 = 1
const PLATFORM_PSP_VITA = 2

const CONTENT_GAME_DATA = 0x04
const CONTENT_GAME_EXEC = 0x05
const CONTENT_PSP2_GD = 0x15
const CONTENT_PSP2_AC = 0x16

export interface PkgHeader { platform: number; contentId: string; serial: string; contentType: number; flags: number; /** Dossier d'installation sous `dev_hdd0/game/` : le numéro de série, sauf si le paquet en déclare un autre (paquet de métadonnées 0xA, cas des DLC). */ installDir: string }

export function parsePkgHeader(buf: Buffer): PkgHeader | null {
  if (buf.length < 0x70 || buf.readUInt32LE(0) !== 0x474b507f) return null
  const metaOffset = buf.readUInt32BE(8), metaCount = buf.readUInt32BE(0x0c)
  const contentId = buf.toString('latin1', 0x30, 0x30 + 36).replace(/\0[\s\S]*$/, '')
  const serial = buf.toString('latin1', 55, 64)
  let contentType = 0, flags = 0
  let installDir = serial.replace(/\0[\s\S]*$/, '')
  let at = metaOffset
  for (let i = 0; i < metaCount && at + 8 <= buf.length; i++) {
    const id = buf.readUInt32BE(at), size = buf.readUInt32BE(at + 4)
    if (id === 2 && size === 4 && at + 12 <= buf.length) contentType = buf.readUInt32BE(at + 8)
    else if (id === 3 && size === 4 && at + 12 <= buf.length) flags = buf.readUInt32BE(at + 8)
    // Même lecture que RPCS3 : au-delà de 8 octets, le paquet 0xA porte le vrai dossier d'installation (après les 8 premiers octets).
    else if (id === 0xa && size > 8 && at + 8 + size <= buf.length) installDir = buf.toString('latin1', at + 16, at + 8 + size).replace(/\0[\s\S]*$/, '')
    at += 8 + size
  }
  return { platform: buf.readUInt16BE(6), contentId, serial, contentType, flags, installDir }
}

const SERIAL_RE = /^[A-Z]{4}\d{5}$/

/** Dossier d'installation (sous `dev_hdd0/game/`) d'un paquet PS3 de type « Game Data », lu dans son en-tête ; null si illisible. */
export async function pkgInstallDir(file: string): Promise<string | null> {
  const fh = await open(file, 'r').catch(() => null)
  if (!fh) return null
  try {
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const h = parsePkgHeader(buf.subarray(0, bytesRead))
    return h && h.platform === PLATFORM_PS3 && h.installDir ? h.installDir : null
  } finally { await fh.close() }
}

export async function probePkg(file: string): Promise<ContentInfo | null> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const h = parsePkgHeader(buf.subarray(0, bytesRead))
    if (!h) return null
    const label = basename(file).replace(/\.[^.]+$/, '')
    const unknown = (console: string, reason: string): ContentInfo => ({ console, kind: 'unknown', titleId: h.contentId, baseKey: '', version: null, source: 'container', label, reason })
    if (h.platform === PLATFORM_PS3) {
      if (!SERIAL_RE.test(h.serial)) return unknown('ps3', 'numéro de série illisible dans le paquet')
      const needs = h.flags & PKG_FLAG_REQUIRE_LICENSE ? ('license' as const) : undefined
      // Type « Game Data » : mise à jour si le drapeau PATCH est posé, sinon contenu additionnel (même règle que RPCS3).
      if (h.contentType === CONTENT_GAME_DATA) return { console: 'ps3', kind: h.flags & PKG_FLAG_PATCH ? 'update' : 'dlc', titleId: h.contentId, baseKey: h.serial, version: null, source: 'container', label, needs }
      if (h.contentType === CONTENT_GAME_EXEC) return { console: 'ps3', kind: 'base', titleId: h.contentId, baseKey: h.serial, version: null, source: 'container', label }
      return unknown('ps3', `type de paquet PS3 non pris en charge (0x${h.contentType.toString(16)})`)
    }
    if (h.platform === PLATFORM_PSP_VITA) {
      if (!SERIAL_RE.test(h.serial)) return unknown('vita', 'numéro de série illisible dans le paquet')
      if (h.contentType === CONTENT_PSP2_AC) return { console: 'vita', kind: 'dlc', titleId: h.contentId, baseKey: h.serial, version: null, source: 'container', label, needs: 'license' }
      if (h.contentType === CONTENT_PSP2_GD && h.flags & PKG_FLAG_PATCH) return { console: 'vita', kind: 'update', titleId: h.contentId, baseKey: h.serial, version: null, source: 'container', label, needs: 'license' }
      return unknown('vita', `paquet Vita ni DLC ni mise à jour identifiable (type 0x${h.contentType.toString(16)})`)
    }
    return unknown('ps3', 'plateforme du paquet non prise en charge')
  } finally { await fh.close() }
}
