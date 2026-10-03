import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { ncsdTitleId } from '../../emulators/azahar'
import { readPs3Serial, sfoString } from '../../emulators/rpcs3'
import { readWiiUTitleId } from '../../saves/identify'
import { readZipEntryHead } from '../hash'
import { probeFile } from './probe'
import type { ProbeContext } from './types'

export interface BaseKeyContext extends ProbeContext {
  /** Dossier de Cemu (keys.txt : clés de disque pour lire le Title ID d'une image .wud/.wux). */
  cemuDir?: string
}

const VITA_SERIAL = /^[A-Z]{4}\d{5}$/

/**
 * Identifiant natif du jeu de base contenu dans un fichier de la bibliothèque (celui que portent aussi ses mises à jour et ses DLC), lu DANS le
 * jeu : conteneur NSP/CIA, en-tête NCSD, numéro de série d'un disque PS3, table de partitions Wii U, `param.sfo` d'un paquet Vita. Null si le format
 * ne permet pas de le lire (le jeu n'aura alors pas de contenu rattachable, jamais de devinette par le nom).
 */
export async function baseKeyOfFile(consoleId: string, path: string, ctx: BaseKeyContext = {}): Promise<string | null> {
  const ext = extname(path).toLowerCase()
  switch (consoleId) {
    case 'switch': {
      const info = await probeFile(path, ctx).catch(() => null)
      return info?.kind === 'base' && info.baseKey ? info.baseKey : null
    }
    case 'n3ds': {
      if (ext === '.cia') {
        const info = await probeFile(path).catch(() => null)
        return info?.kind === 'base' ? info.baseKey : null
      }
      if (ext !== '.3ds' && ext !== '.cci') return null
      const fh = await open(path, 'r')
      try { const b = Buffer.alloc(0x110); await fh.read(b, 0, b.length, 0); return ncsdTitleId(b) } finally { await fh.close() }
    }
    case 'ps3': return ext === '.iso' ? readPs3Serial(path) : null
    case 'wiiu': return readWiiUTitleId(path, ctx.cemuDir)
    case 'vita': {
      if (ext !== '.vpk' && ext !== '.zip') return null
      const sfo = await readZipEntryHead(path, 'sce_sys/param.sfo', 64 * 1024)
      const id = sfo ? sfoString(sfo, 'TITLE_ID') : null
      return id && VITA_SERIAL.test(id) ? id : null
    }
    default: return null
  }
}
