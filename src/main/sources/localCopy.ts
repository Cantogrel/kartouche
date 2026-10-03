import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/** Dossier des copies locales des listes de sources ajoutées depuis un fichier. */
export const sourcesDir = (dataDir: string): string => join(dataDir, 'sources')

/** Une valeur qui n'est pas une URL http(s) est un chemin de fichier local. */
export const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s)

/** Nom de la copie : le nom du fichier d'origine (lisible) + une empreinte du chemin complet (deux fichiers de même nom ne s'écrasent pas). */
const copyName = (origin: string): string => {
  const stem = basename(origin, extname(origin)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'source'
  return `${stem}-${createHash('sha1').update(origin.toLowerCase()).digest('hex').slice(0, 8)}.json`
}

/** Écrit la copie locale (le JSON déjà lu et validé) et renvoie son chemin. */
export function saveCopy(dir: string, origin: string, data: unknown): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, copyName(origin))
  writeFileSync(path, JSON.stringify(data))
  return path
}

export function removeCopy(path: string | null | undefined): void {
  if (path) rmSync(path, { force: true })
}

/**
 * Listes ajoutées avant l'existence des copies locales : si leur fichier d'origine est encore là, on en garde une copie maintenant.
 * Un fichier d'origine déjà disparu ou illisible est laissé tel quel (rien à copier).
 */
export function backfillLocalCopies(db: DatabaseSync, dir: string): number {
  const rows = db.prepare('SELECT id, url FROM source_lists WHERE local_copy IS NULL').all() as { id: number; url: string }[]
  let n = 0
  for (const r of rows) {
    if (isHttpUrl(r.url) || !existsSync(r.url)) continue
    try {
      const path = saveCopy(dir, r.url, JSON.parse(readFileSync(r.url, 'utf8')))
      db.prepare('UPDATE source_lists SET local_copy = ? WHERE id = ?').run(path, r.id)
      n++
    } catch { /* fichier illisible : pas de copie */ }
  }
  return n
}
