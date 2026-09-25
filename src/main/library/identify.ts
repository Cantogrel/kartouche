import type { DatabaseSync } from 'node:sqlite'
import { ROM_EXTENSIONS, type MatchKind } from '@shared/library'
import { matchKey } from '../catalog/popularity'

export interface Identified { gameId: number | null; console: string | null; title: string | null; match: MatchKind; candidates: string[] }

interface Row { id: number; console: string; name: string | null; title: string; base: string | null; dup: number }
const COLS = 'id, console, name, title, base, dup'

/** Consoles possibles d'après l'extension (vide si non reconnue). */
export const consolesForExt = (ext: string): readonly string[] => ROM_EXTENSIONS[ext.toLowerCase().replace(/^\./, '')] ?? []

/** Ramène une entrée dupliquée (autre région/révision) à l'entrée représentative du même jeu : c'est elle qui a fiche et images. */
function representative(db: DatabaseSync, r: Row): Row {
  if (!r.dup || !r.base) return r
  return (db.prepare(`SELECT ${COLS} FROM catalog_games WHERE console = ? AND base = ? AND dup = 0`).get(r.console, r.base) as Row | undefined) ?? r
}

/**
 * Identifie un fichier : 1) empreinte (CRC32 + taille, sinon SHA1) contre le catalogue ; 2) nom de fichier contre le titre normalisé
 * (Switch et images de disque sans empreinte exploitable). Les consoles autorisées par l'extension arbitrent les collisions.
 */
export function identify(db: DatabaseSync, f: { name: string; ext: string; size?: number; crc?: string; sha1?: string }): Identified {
  const allowed = consolesForExt(f.ext)
  const ok = (c: string): boolean => allowed.length === 0 || allowed.includes(c)
  const pick = (rows: Row[], match: MatchKind): Identified | null => {
    const inExt = rows.filter((r) => ok(r.console))
    const consoles = [...new Set(inExt.map((r) => r.console))]
    if (consoles.length > 1) return { gameId: null, console: null, title: null, match: 'none', candidates: consoles }
    if (consoles.length === 0) return null
    const r = representative(db, inExt.find((x) => !x.dup) ?? inExt[0])
    return { gameId: r.id, console: r.console, title: r.name ?? r.title, match, candidates: consoles }
  }
  let hit: Identified | null = null
  if (f.crc) {
    // Les DAT stockent les empreintes en majuscules ; les deux graphies sont testées pour rester sur l'index.
    const [up, low] = [f.crc.toUpperCase(), f.crc.toLowerCase()]
    const rows = (f.size !== undefined
      ? db.prepare(`SELECT ${COLS} FROM catalog_games WHERE crc IN (?, ?) AND (size IS NULL OR size = ?)`).all(up, low, f.size)
      : db.prepare(`SELECT ${COLS} FROM catalog_games WHERE crc IN (?, ?)`).all(up, low)) as unknown as Row[]
    hit = pick(rows, 'hash')
  }
  if (!hit && f.sha1) hit = pick(db.prepare(`SELECT ${COLS} FROM catalog_games WHERE sha1 IN (?, ?)`).all(f.sha1.toUpperCase(), f.sha1.toLowerCase()) as unknown as Row[], 'hash')
  if (hit && hit.gameId !== null) return hit
  const key = matchKey(f.name)
  if (key) {
    const byName = pick(db.prepare(`SELECT ${COLS} FROM catalog_games WHERE base = ?`).all(key) as unknown as Row[], 'name')
    if (byName && byName.gameId !== null) return byName
    if (byName && !hit) return byName
  }
  if (hit) return hit
  return { gameId: null, console: allowed.length === 1 ? allowed[0] : null, title: null, match: 'none', candidates: [...allowed] }
}
