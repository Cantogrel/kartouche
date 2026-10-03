import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, cp, link, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { ImportItem } from '@shared/library'
import { baseKeyOfFile, type BaseKeyContext } from './baseKey'
import type { ContentInfo } from './types'

/** Où RomVault range les mises à jour/DLC d'un jeu : à côté des ROM de sa console, un dossier par jeu parent. */
export const contentDir = (romsDir: string, consoleId: string, baseKey: string): string => join(romsDir, consoleId, '.content', baseKey)

export interface ContentEnv extends BaseKeyContext {
  romsDir: string
  /** Réglages d'import (copier dans le dossier de ROM / supprimer l'original). */
  copy: boolean
  deleteSource: boolean
  /** L'émulateur lit ses contenus dans un dossier configuré (Eden) : rangés sous `.content/` même sans copie, par lien physique si possible. */
  managed: boolean
  /** Le fichier est un temporaire appartenant à l'importer (extrait d'une archive) : toujours déplacé hors du dossier de travail. */
  owned?: boolean
  logDir?: string
}

/** Trace pour l'utilisateur (`<logs>/content.log`) : jamais bloquant. */
export async function contentLog(logDir: string | undefined, message: string): Promise<void> {
  if (!logDir) return
  await mkdir(logDir, { recursive: true }).catch(() => undefined)
  await appendFile(join(logDir, 'content.log'), `${new Date().toISOString()} ${message}\n`).catch(() => undefined)
}

function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const ext = extname(name), stem = basename(name, ext)
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`
}

/** Taille d'un fichier, ou somme des fichiers d'un dossier (titre Wii U). */
export async function sizeOf(path: string): Promise<number> {
  const st = await stat(path)
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const e of await readdir(path, { withFileTypes: true })) total += await sizeOf(join(path, e.name))
  return total
}

const sameOrInside = (path: string, dir: string): boolean => {
  const p = resolve(path).toLowerCase(), d = resolve(dir).toLowerCase()
  return p === d || p.startsWith(d + '\\') || p.startsWith(d + '/')
}

/**
 * Range le fichier du contenu et renvoie son chemin définitif. Copie (puis suppression de l'original si demandé) en mode « copier », déplacement
 * d'un temporaire d'archive, lien physique (sinon copie) quand l'émulateur exige un dossier géré, sinon le fichier reste où il est.
 */
async function placeMain(src: string, info: Pick<ContentInfo, 'console' | 'baseKey'>, env: ContentEnv): Promise<string> {
  const dir = contentDir(env.romsDir, info.console, info.baseKey)
  if (sameOrInside(src, dir)) return src
  const isDir = (await stat(src)).isDirectory()
  if (!env.owned && !env.copy && !env.managed) return src
  await mkdir(dir, { recursive: true })
  const dest = join(dir, freeName(dir, basename(src)))
  if (env.owned) {
    try { await rename(src, dest) } catch { await copyOne(src, dest, isDir); await rm(src, { recursive: true, force: true }) }
    return dest
  }
  if (!env.copy && env.managed && !isDir) {
    try { await link(src, dest); return dest } catch { /* autre volume ou système sans lien physique : copie */ }
  }
  await copyOne(src, dest, isDir)
  if (env.deleteSource) await rm(src, { recursive: true, force: true })
  return dest
}

/**
 * Range le contenu (voir `placeMain`) et, pour un paquet Vita, le fichier `.zrif` voisin que l'utilisateur a pu fournir : c'est une donnée à lui, copiée à côté du paquet
 * rangé (`<paquet>.zrif`) pour que l'installation dans Vita3K puisse l'utiliser. Jamais cherché ailleurs, jamais inventé.
 */
export async function placeContent(src: string, info: Pick<ContentInfo, 'console' | 'baseKey'>, env: ContentEnv): Promise<string> {
  const dest = await placeMain(src, info, env)
  if (info.console === 'vita' && /\.pkg$/i.test(src) && resolve(dest).toLowerCase() !== resolve(src).toLowerCase()) {
    const candidates = [`${src}.zrif`, join(dirname(src), `${basename(src, extname(src))}.zrif`)]
    const found = candidates.find((c) => existsSync(c))
    if (found) await copyFile(found, `${dest}.zrif`).catch(() => undefined)
    if (found && env.deleteSource && !env.owned) await rm(found, { force: true }).catch(() => undefined)
  }
  return dest
}

async function copyOne(src: string, dest: string, isDir: boolean): Promise<void> {
  if (isDir) { await cp(src, dest, { recursive: true }); return }
  await copyFile(src, dest)
  if ((await stat(dest)).size !== (await stat(src)).size) { await rm(dest, { force: true }); throw new Error('copie incomplète') }
}

export interface ParentRow { id: number; title: string }

/**
 * Jeu de la bibliothèque dont l'identifiant natif est `baseKey` (Title ID, numéro de série…). Un jeu importé avant l'existence de cette fonction n'a pas
 * encore son identifiant : on le lit alors dans son fichier (et on le mémorise). Jamais de rapprochement par le nom.
 */
export async function findParent(db: DatabaseSync, consoleId: string, baseKey: string, ctx: BaseKeyContext): Promise<ParentRow | null> {
  if (!baseKey) return null
  const want = baseKey.toUpperCase()
  const rows = db.prepare('SELECT id, title, path, title_id, missing FROM library WHERE console = ?').all(consoleId) as { id: number; title: string; path: string; title_id: string | null; missing: number }[]
  const exact = rows.find((r) => r.title_id?.toUpperCase() === want)
  if (exact) return { id: exact.id, title: exact.title }
  for (const r of rows) {
    if (r.title_id || r.missing === 1 || !existsSync(r.path)) continue
    const key = await baseKeyOfFile(consoleId, r.path, ctx).catch(() => null)
    if (!key) continue
    db.prepare('UPDATE library SET title_id = ? WHERE id = ? AND title_id IS NULL').run(key, r.id)
    if (key.toUpperCase() === want) return { id: r.id, title: r.title }
  }
  return null
}

const insertContent = (db: DatabaseSync): ReturnType<DatabaseSync['prepare']> => db.prepare(
  `INSERT INTO library_content (library_id, kind, title_id, version, label, path, size, added_at, state, needs, source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)

/** Déjà connu pour ce jeu (même identifiant et même version, ou même fichier) ? */
const isDuplicate = (db: DatabaseSync, libraryId: number, info: ContentInfo, path: string): boolean =>
  !!db.prepare('SELECT 1 FROM library_content WHERE path = ? OR (library_id = ? AND kind = ? AND title_id = ? AND COALESCE(version, \'\') = ?)')
    .get(path, libraryId, info.kind, info.titleId, info.version ?? '')

/**
 * Rattache un contenu (`update`/`dlc`) à son jeu, ou le met en attente s'il n'est pas encore là. Le fichier d'un contenu sans jeu parent n'est jamais perdu
 * ni transformé en jeu : il est rangé (ou référencé) et mémorisé dans `library_orphans`, puis rattaché automatiquement à l'import du jeu (`adoptOrphans`).
 */
export async function attachContent(db: DatabaseSync, info: ContentInfo, file: string, env: ContentEnv): Promise<{ item: ImportItem; libraryId?: number }> {
  const kind = info.kind as 'update' | 'dlc'
  const label = info.label ?? basename(file)
  // Jeu parent invérifiable (dump sans identifiant lisible, repéré seulement par mot-clé) : jamais rattaché par devinette, jamais mis en attente
  // sous une clé vide — le fichier reste tel quel et le cas est signalé.
  if (!info.baseKey) {
    await contentLog(env.logDir, `${kind} sans jeu parent identifiable (${info.source}) : ${file}`)
    return { item: { file, status: 'error', console: info.console, title: label, error: `${kind === 'update' ? 'mise à jour' : 'DLC'} : jeu parent non identifiable de façon fiable (fichier laissé en place)` } }
  }
  const parent = await findParent(db, info.console, info.baseKey, env)
  if (!parent) {
    const known = db.prepare('SELECT 1 FROM library_orphans WHERE path = ? OR (console = ? AND base_key = ? AND title_id = ? AND COALESCE(version, \'\') = ?)').get(resolve(file), info.console, info.baseKey, info.titleId, info.version ?? '')
    if (known) return { item: { file, status: 'duplicate', console: info.console, title: label } }
    const size = await sizeOf(file)
    const stored = await placeContent(file, info, env)
    db.prepare('INSERT OR IGNORE INTO library_orphans (console, base_key, kind, title_id, version, label, path, size, needs, source, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(info.console, info.baseKey, kind, info.titleId, info.version, label, stored, size, info.needs ?? null, info.source, Date.now())
    await contentLog(env.logDir, `orphelin ${kind} ${info.titleId} (jeu parent ${info.baseKey} absent de la bibliothèque) : ${file}`)
    return { item: { file, status: 'orphan', console: info.console, title: label, contentKind: kind, error: info.baseKey } }
  }
  if (isDuplicate(db, parent.id, info, resolve(file))) return { item: { file, status: 'duplicate', console: info.console, title: label, parent: parent.title }, libraryId: parent.id }
  const size = await sizeOf(file)
  const stored = await placeContent(file, info, env)
  insertContent(db).run(parent.id, kind, info.titleId, info.version, label, stored, size, Date.now(), info.needs ?? null, info.source)
  return { item: { file, status: 'attached', console: info.console, title: label, contentKind: kind, parent: parent.title }, libraryId: parent.id }
}

/**
 * Rattache au jeu qui vient d'arriver (identifiant natif `baseKey`) les contenus qui l'attendaient. Un fichier disparu entre-temps est simplement oublié.
 * Renvoie le nombre de contenus rattachés.
 */
export function adoptOrphans(db: DatabaseSync, libraryId: number, consoleId: string, baseKey: string): number {
  const rows = db.prepare('SELECT id, kind, title_id, version, label, path, size, needs, source FROM library_orphans WHERE console = ? AND UPPER(base_key) = UPPER(?)').all(consoleId, baseKey) as
    { id: number; kind: string; title_id: string | null; version: string | null; label: string; path: string; size: number; needs: string | null; source: string }[]
  let adopted = 0
  for (const o of rows) {
    db.prepare('DELETE FROM library_orphans WHERE id = ?').run(o.id)
    if (!existsSync(o.path)) continue
    const dup = db.prepare('SELECT 1 FROM library_content WHERE path = ? OR (library_id = ? AND kind = ? AND title_id = ? AND COALESCE(version, \'\') = ?)').get(o.path, libraryId, o.kind, o.title_id ?? '', o.version ?? '')
    if (dup) continue
    insertContent(db).run(libraryId, o.kind, o.title_id, o.version, o.label, o.path, o.size, Date.now(), o.needs, o.source)
    adopted++
  }
  return adopted
}

/**
 * Le jeu quitte la bibliothèque mais ses fichiers restent : ses mises à jour/DLC passent en attente (`library_orphans`) au lieu d'être oubliés, et se rattacheront
 * si le jeu est réimporté. À appeler avant la suppression de la ligne du jeu (qui efface ses lignes de contenu en cascade).
 */
export function parkContent(db: DatabaseSync, libraryId: number): void {
  const game = db.prepare('SELECT console, title_id FROM library WHERE id = ?').get(libraryId) as { console: string; title_id: string | null } | undefined
  if (!game?.title_id) return
  const rows = db.prepare('SELECT kind, title_id, version, label, path, size, needs, source FROM library_content WHERE library_id = ?').all(libraryId) as unknown as
    { kind: string; title_id: string | null; version: string | null; label: string; path: string; size: number; needs: string | null; source: string }[]
  for (const r of rows) {
    if (!existsSync(r.path)) continue
    db.prepare('INSERT OR IGNORE INTO library_orphans (console, base_key, kind, title_id, version, label, path, size, needs, source, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(game.console, game.title_id, r.kind, r.title_id, r.version, r.label, r.path, r.size, r.needs, r.source, Date.now())
  }
}
