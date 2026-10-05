import type { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type { LaunchSpec } from '@shared/launch'
import { exeTitleFromPath, isExecutablePath, type AddExeResult } from '@shared/exeEntry'
import { upsertExternalEntry } from './external'
import { setCustomImage } from './customArt'

/*
 * Exécutable présent sur le PC (hors launcher) ajouté comme un jeu : titre déduit du nom de fichier, icône lue dans l'exécutable (posée comme image
 * personnelle, donc modifiable), raccourcis .lnk suivis jusqu'à leur cible. Aucun fichier de l'utilisateur n'est copié ni modifié.
 */

export interface AddExeDeps {
  /** Cible, arguments et dossier d'un raccourci Windows (.lnk) ; null s'il est illisible. */
  readShortcut: (path: string) => { target: string; args?: string; cwd?: string } | null
  /** Icône de l'exécutable en PNG ; null si indisponible. */
  icon: (path: string) => Promise<Buffer | null>
  dataDir: string
}

export async function addExecutables(db: DatabaseSync, paths: string[], deps: AddExeDeps): Promise<AddExeResult> {
  const result: AddExeResult = { added: [], existing: [], invalid: [] }
  for (const raw of paths) {
    let exe = raw
    let args: string | undefined
    let cwd: string | undefined
    let name = exeTitleFromPath(raw)
    if (extname(raw).toLowerCase() === '.lnk') {
      const link = deps.readShortcut(raw)
      if (!link || !link.target) { result.invalid.push(raw); continue }
      exe = link.target; args = link.args || undefined; cwd = link.cwd || undefined
    }
    if (!isExecutablePath(exe) || !existsSync(exe) || !statSync(exe).isFile()) { result.invalid.push(raw); continue }
    const spec: LaunchSpec = { type: 'exe', exe, ...(args ? { args } : {}), ...(cwd ? { cwd } : {}) }
    const r = upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: name || exeTitleFromPath(exe) || basename(exe), launch: spec })
    if (!r.ok) { result.invalid.push(raw); continue }
    if (!r.created) { result.existing.push(r.id); continue }
    result.added.push(r.id)
    const png = await deps.icon(exe).catch(() => null)
    if (png && png.length > 0) {
      const dir = await mkdtemp(join(tmpdir(), 'kartouche-icon-'))
      try {
        const file = join(dir, 'icon.png')
        await writeFile(file, png)
        await setCustomImage(db, deps.dataDir, r.id, 'icon', file)
      } catch { /* l'icône est un confort : l'entrée reste ajoutée sans */ } finally { await rm(dir, { recursive: true, force: true }) }
    }
  }
  return result
}

/** Modifie les arguments, le dossier de travail ou l'exécutable d'une entrée `exe`. Une valeur vide efface l'argument/le dossier. */
export function updateExeLaunch(db: DatabaseSync, id: number, patch: { exe?: string; args?: string; cwd?: string }): boolean {
  const row = db.prepare("SELECT launch FROM library WHERE id = ? AND kind = 'exe'").get(id) as { launch: string | null } | undefined
  if (!row?.launch) return false
  let spec: LaunchSpec
  try { spec = JSON.parse(row.launch) as LaunchSpec } catch { return false }
  if (patch.exe !== undefined) {
    const exe = patch.exe.trim()
    if (!isExecutablePath(exe)) return false
    spec.exe = exe
  }
  if (patch.args !== undefined) { const a = patch.args.trim(); if (a.length > 2000) return false; if (a) spec.args = a; else delete spec.args }
  if (patch.cwd !== undefined) { const c = patch.cwd.trim(); if (c) spec.cwd = c; else delete spec.cwd }
  const path = spec.exe!
  const clash = db.prepare('SELECT 1 FROM library WHERE path = ? AND id <> ?').get(path, id)
  if (clash) return false
  db.prepare('UPDATE library SET launch = ?, path = ?, missing = ? WHERE id = ?').run(JSON.stringify(spec), path, existsSync(path) ? 0 : 1, id)
  return true
}

export const defaultCwd = (exe: string): string => dirname(exe)
