import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DetectedGame } from '@shared/connectors'
import type { Connector } from './core'

/*
 * itch.io : lit seulement la base locale de l'application itch (`%APPDATA%\itch\db\butler.db`, tables des jeux installés et de leurs dossiers), sur une copie
 * temporaire : l'original n'est jamais ouvert. Le jeu est lancé par son exécutable.
 */

export interface ItchRow { caveId: string; gameId: number | null; title: string | null; folder: string | null; location: string | null; verdict: string | null }

export interface ItchDeps {
  dbPath(): string | null
  rows(dbPath: string): ItchRow[]
  exists(path: string): boolean
}

export const realItchDeps: ItchDeps = {
  dbPath: () => {
    const p = join(process.env.APPDATA ?? '', 'itch', 'db', 'butler.db')
    return process.env.APPDATA && existsSync(p) ? p : null
  },
  rows: (dbPath) => {
    const dir = mkdtempSync(join(tmpdir(), 'kartouche-itch-'))
    try {
      const copy = join(dir, 'butler.db')
      copyFileSync(dbPath, copy)
      for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext)
      const db = new DatabaseSync(copy, { readOnly: true })
      try {
        return db.prepare(
          'SELECT c.id AS caveId, c.game_id AS gameId, g.title AS title, c.install_folder_name AS folder, l.path AS location, c.verdict AS verdict ' +
          'FROM caves c LEFT JOIN games g ON g.id = c.game_id LEFT JOIN install_locations l ON l.id = c.install_location_id'
        ).all() as unknown as ItchRow[]
      } finally { db.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  },
  exists: existsSync
}

/** Jeu décrit par une ligne de la base itch ; null sans titre, sans dossier d'installation ou sans exécutable Windows connu. */
export function gameFromItch(r: ItchRow, exists: (p: string) => boolean): DetectedGame | null {
  if (!r.title || !r.caveId) return null
  let base = ''
  let relative = ''
  try {
    const v = JSON.parse(r.verdict ?? 'null') as { basePath?: unknown; candidates?: { path?: unknown; flavor?: unknown }[] } | null
    base = typeof v?.basePath === 'string' ? v.basePath : ''
    const c = (v?.candidates ?? []).find((x) => typeof x.path === 'string' && (x.flavor === 'windows' || /\.exe$/i.test(x.path as string)))
    relative = typeof c?.path === 'string' ? c.path : ''
  } catch { return null }
  if (!base && r.location && r.folder) base = join(r.location, r.folder)
  if (!base || !relative) return null
  const exe = join(base, relative)
  if (!exists(exe)) return null
  return { nativeId: r.caveId, title: r.title, exe, installDir: base, cwd: base }
}

export function itchConnector(deps: ItchDeps = realItchDeps): Connector {
  return {
    id: 'itch',
    name: 'itch.io',
    detect: async () => deps.dbPath() !== null,
    scan: async () => {
      const db = deps.dbPath()
      if (!db) return []
      return deps.rows(db).map((r) => gameFromItch(r, deps.exists)).filter((g): g is DetectedGame => g !== null)
    }
  }
}
