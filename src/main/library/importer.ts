import type { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { ROM_EXTENSIONS, type ImportItem, type ImportResult, type LibraryProgress } from '@shared/library'
import { hashFile, readZip } from './hash'
import { identify } from './identify'

export interface ImportOptions {
  /** Copier dans <roms>/<console>/ (sinon le fichier reste où il est). */
  copy: boolean
  deleteSource: boolean
  romsDir: string
}

const extOf = (p: string): string => extname(p).slice(1).toLowerCase()
const isRom = (p: string): boolean => extOf(p) in ROM_EXTENSIONS || extOf(p) === 'zip'
const stemOf = (p: string): string => basename(p, extname(p))

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.isFile()) out.push(p)
  }
}

/** Fichiers référencés par une feuille .cue (pistes .bin), résolus par rapport à son dossier. */
export async function cueFiles(cue: string): Promise<string[]> {
  const text = await readFile(cue, 'latin1')
  const files = [...text.matchAll(/^\s*FILE\s+"([^"]+)"/gim)].map((m) => resolve(dirname(cue), m[1]))
  return files.filter((f) => existsSync(f))
}

/** Nom libre dans le dossier de destination (« Jeu (2).iso » si « Jeu.iso » existe déjà). */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const ext = extname(name), stem = basename(name, ext)
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`
}

interface Prepared { crc?: string; sha1?: string; size: number; name: string; ext: string }

async function prepare(file: string, extra: string[]): Promise<Prepared | string> {
  const ext = extOf(file)
  if (ext === 'zip') {
    const entries = (await readZip(file))?.filter((z) => extOf(z.name) in ROM_EXTENSIONS)
    if (!entries) return 'archive illisible'
    if (entries.length !== 1) return 'archive : un seul fichier de ROM attendu'
    const z = entries[0]
    return { crc: z.crc, size: z.size, name: stemOf(z.name), ext: extOf(z.name) }
  }
  // Disque .cue : l'empreinte de référence est celle de la première piste.
  const target = ext === 'cue' && extra[0] ? extra[0] : file
  const h = await hashFile(target)
  return { crc: h.crc, sha1: h.sha1, size: ext === 'cue' ? h.size : (await stat(file)).size, name: stemOf(file), ext }
}

/**
 * Importe fichiers et dossiers : empreinte, identification contre le catalogue, copie dans le dossier de la console,
 * suppression éventuelle de l'original, enregistrement en bibliothèque. Un fichier en échec n'arrête pas les suivants.
 */
export async function importPaths(db: DatabaseSync, paths: string[], opt: ImportOptions, onProgress: (p: LibraryProgress) => void = () => undefined): Promise<ImportResult> {
  const items: ImportItem[] = []
  let ignored = 0
  const files: string[] = []
  for (const p of paths) {
    try {
      if ((await stat(p)).isDirectory()) {
        const found: string[] = []
        await walk(p, found)
        for (const f of found) { if (isRom(f)) files.push(f); else ignored++ }
      } else if (isRom(p)) files.push(p)
      else items.push({ file: p, status: 'error', error: 'extension non prise en charge' })
    } catch (e) { items.push({ file: p, status: 'error', error: (e as Error).message }) }
  }

  // Les pistes d'une feuille .cue voyagent avec elle : elles ne sont pas importées seules.
  const extras = new Map<string, string[]>()
  const consumed = new Set<string>()
  for (const f of files) if (extOf(f) === 'cue') {
    const refs = await cueFiles(f).catch(() => [])
    extras.set(f, refs)
    refs.forEach((r) => consumed.add(resolve(r).toLowerCase()))
  }
  const queue = files.filter((f) => !consumed.has(resolve(f).toLowerCase()))

  const sameRom = db.prepare('SELECT id, path FROM library WHERE path = ? OR (console = ? AND crc = ? AND size = ?)')
  const byGame = db.prepare('SELECT id, path FROM library WHERE game_id = ? AND console = ?')
  const relink = db.prepare('UPDATE library SET path = ?, size = ?, crc = ?, sha1 = ?, match = ?, missing = 0 WHERE id = ?')
  const insert = db.prepare('INSERT INTO library (game_id, console, title, path, size, crc, sha1, match, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  let done = 0
  for (const file of queue) {
    onProgress({ done, total: queue.length, current: basename(file) })
    try {
      const refs = extras.get(file) ?? []
      const prep = await prepare(file, refs)
      if (typeof prep === 'string') { items.push({ file, status: 'error', error: prep }); continue }
      const id = identify(db, prep)
      const cons = id.console ?? (id.candidates.length === 1 ? id.candidates[0] : null)
      if (!cons) { items.push({ file, status: 'ambiguous', error: id.candidates.join(', ') }); continue }
      const title = id.title ?? prep.name
      const inRoms = resolve(file).toLowerCase().startsWith(resolve(opt.romsDir).toLowerCase())
      const same = sameRom.all(file, cons, prep.crc ?? '', prep.size) as { id: number; path: string }[]
      if (same.some((r) => existsSync(r.path))) { items.push({ file, status: 'duplicate', console: cons, title, match: id.match }); continue }
      // Entrée du même jeu dont le fichier a disparu (ou jamais existé : jeu ajouté depuis le catalogue) : la ROM s'y rattache.
      const target = same[0] ?? (id.gameId !== null ? (byGame.all(id.gameId, cons) as { id: number; path: string }[]).find((r) => !existsSync(r.path)) : undefined)

      let dest = file
      if (opt.copy && !inRoms) {
        const dir = join(opt.romsDir, cons)
        await mkdir(dir, { recursive: true })
        const name = freeName(dir, basename(file))
        dest = join(dir, name)
        await copyFile(file, dest)
        // Les pistes d'un .cue gardent leur nom : la feuille les référence.
        for (const r of refs) await copyFile(r, join(dir, basename(r))).catch(() => undefined)
        if ((await stat(dest)).size !== (await stat(file)).size) { await rm(dest, { force: true }); throw new Error('copie incomplète') }
        if (opt.deleteSource) for (const f of [file, ...refs]) await rm(f, { force: true })
      }
      if (target) relink.run(dest, prep.size, prep.crc ?? null, prep.sha1 ?? null, id.match, target.id)
      else insert.run(id.gameId, cons, title, dest, prep.size, prep.crc ?? null, prep.sha1 ?? null, id.match, Date.now())
      items.push({ file, status: 'added', console: cons, title, match: id.match })
    } catch (e) {
      items.push({ file, status: 'error', error: (e as Error).message })
    }
    done++
  }
  onProgress({ done, total: queue.length, current: '' })
  return { items, ignored }
}
