import type { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { emulatorForConsole } from '@shared/emulators'
import { MAX_BACKUPS, type BackupInfo, type SaveInfo } from '@shared/saves'
import { getRow } from '../emulators/emulatorStore'
import { patchCfg } from '../emulators/configure'

/**
 * Dossiers où chaque émulateur range ses sauvegardes et ses états, relatifs à son dossier d'installation (mode portable).
 * Seuls ceux qui existent sont pris en compte. RetroArch et melonDS sont traités à part : leurs fichiers portent le nom de la ROM.
 */
export const EMULATOR_SAVE_DIRS: Record<string, readonly string[]> = {
  duckstation: ['memcards', 'savestates'],
  pcsx2: ['memcards', 'sstates'],
  dolphin: [join('User', 'GC'), join('User', 'Wii'), join('User', 'StateSaves')],
  azahar: [join('user', 'sdmc'), join('user', 'states')],
  cemu: [join('mlc01', 'usr', 'save')],
  eden: [join('user', 'nand', 'user', 'save')],
  rpcs3: [join('dev_hdd0', 'home'), 'savestates'],
  ppsspp: [join('memstick', 'PSP', 'SAVEDATA'), join('memstick', 'PSP', 'PPSSPP_STATE')],
  vita3k: [join('ux0', 'user', '00', 'savedata')]
}

export interface SaveTarget {
  emulator: string
  scope: 'game' | 'emulator'
  /** Sous-dossier des copies : `g<id>` (propre au jeu) ou `all` (émulateur entier). */
  key: string
  /** Dossier de référence : `items` en sont relatifs. */
  root: string
  /** Fichiers ou dossiers à copier, relatifs à `root`. */
  items: string[]
  /** Dossiers réels à montrer à l'utilisateur. */
  dirs: string[]
}

export interface EntryRef { id: number; console: string; path: string }

/** Dossier de RetroArch pour ses sauvegardes et états : hors de l'installation, donc conservé à la désinstallation. */
export const retroarchSavesRoot = (savesRoot: string): string => join(savesRoot, 'retroarch')

const byBase = async (dir: string, base: string, rel: string, ext?: RegExp): Promise<string[]> =>
  (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(`${base}.`) && (!ext || ext.test(extname(n)))).map((n) => join(rel, n))

/**
 * Identifiant du jeu (6 caractères, ex. « GZLP01 ») lu dans l'en-tête du disque : en clair au début d'un .iso/.gcm, à 0x200 dans un .wbfs,
 * copié à 0x58 dans un .rvz/.wia. Null pour les autres formats (compressés : .gcz, .ciso…) ou un fichier illisible.
 */
export async function readDiscId(path: string): Promise<string | null> {
  const offset: Record<string, number> = { '.iso': 0, '.gcm': 0, '.wbfs': 0x200, '.rvz': 0x58, '.wia': 0x58 }
  const at = offset[extname(path).toLowerCase()]
  if (at === undefined) return null
  const f = await open(path, 'r').catch(() => null)
  if (!f) return null
  try {
    const buf = Buffer.alloc(6)
    const { bytesRead } = await f.read(buf, 0, 6, at)
    const id = buf.toString('latin1')
    return bytesRead === 6 && /^[A-Z0-9]{6}$/.test(id) ? id : null
  } catch { return null } finally { await f.close() }
}

/**
 * Dolphin : sauvegardes propres à un jeu quand on connaît son identifiant. Cartes mémoire en dossier (`User/GC/<région>/Card A|B/<éditeur>-<ID4>-….gci`),
 * données Wii (`User/Wii/title/00010000/<ID4 en hexadécimal>/`) et états (`User/StateSaves/<ID6>.s01…`).
 * Une carte mémoire en fichier unique (.raw) mélange tous les jeux : elle n'est pas prise en compte.
 */
async function dolphinGameItems(dir: string, id6: string): Promise<string[]> {
  const items: string[] = []
  const id4 = id6.slice(0, 4)
  const gc = join('User', 'GC')
  for (const region of await readdir(join(dir, gc)).catch(() => [] as string[])) {
    for (const card of ['Card A', 'Card B']) {
      const rel = join(gc, region, card)
      for (const n of await readdir(join(dir, rel)).catch(() => [] as string[])) {
        const m = /^[0-9A-Z]{2}-([0-9A-Z]{4})-.*\.gci$/i.exec(n)
        if (m && m[1] === id4) items.push(join(rel, n))
      }
    }
  }
  const wii = join('User', 'Wii', 'title', '00010000', Buffer.from(id4, 'latin1').toString('hex'))
  if (existsSync(join(dir, wii))) items.push(wii)
  for (const n of await readdir(join(dir, 'User', 'StateSaves')).catch(() => [] as string[])) if (n.startsWith(`${id6}.`)) items.push(join('User', 'StateSaves', n))
  return items
}

/** Où sont les sauvegardes de ce jeu ; null si son émulateur n'est pas connu ou pas installé. */
export async function resolveTarget(db: DatabaseSync, savesRoot: string, entry: EntryRef): Promise<SaveTarget | null> {
  const def = emulatorForConsole(entry.console)
  if (!def) return null
  const base = basename(entry.path, extname(entry.path))
  if (def.id === 'retroarch') {
    const root = retroarchSavesRoot(savesRoot)
    const items = [...await byBase(join(root, 'saves'), base, 'saves'), ...await byBase(join(root, 'states'), base, 'states')]
    return { emulator: def.id, scope: 'game', key: `g${entry.id}`, root, items, dirs: [root] }
  }
  if (def.id === 'melonds') {
    // melonDS écrit ses sauvegardes (.sav) et états (.ml1…) à côté de la ROM.
    const root = dirname(entry.path)
    return { emulator: def.id, scope: 'game', key: `g${entry.id}`, root, items: await byBase(root, base, '', /^\.(sav|ml\d)$/i), dirs: [root] }
  }
  const row = getRow(db, def.id)
  if (def.id === 'dolphin' && row) {
    const id = await readDiscId(entry.path)
    if (id) return { emulator: def.id, scope: 'game', key: `g${entry.id}`, root: row.dir, items: await dolphinGameItems(row.dir, id), dirs: [join(row.dir, 'User')] }
  }
  const rels = EMULATOR_SAVE_DIRS[def.id]
  if (!row || !rels) return null
  const items = rels.filter((r) => existsSync(join(row.dir, r)))
  return { emulator: def.id, scope: 'emulator', key: 'all', root: row.dir, items, dirs: items.map((r) => join(row.dir, r)) }
}

/** Dossier précis des sauvegardes : celui du premier fichier du jeu, ou du premier dossier de l'émulateur ; à défaut le premier emplacement connu. */
function locationOf(t: SaveTarget): string | null {
  if (t.items.length) return t.scope === 'game' ? dirname(join(t.root, t.items[0])) : join(t.root, t.items[0])
  return t.dirs.find((d) => existsSync(d)) ?? (existsSync(t.root) ? t.root : null)
}

/** Date de modification la plus récente parmi les éléments (dossiers parcourus en profondeur) ; null s'il n'y en a aucun. */
async function newest(root: string, items: string[]): Promise<{ files: number; modified: number | null }> {
  let files = 0
  let modified: number | null = null
  const walk = async (p: string): Promise<void> => {
    const s = await stat(p).catch(() => null)
    if (!s) return
    if (s.isDirectory()) { for (const n of await readdir(p)) await walk(join(p, n)); return }
    files++
    if (modified === null || s.mtimeMs > modified) modified = s.mtimeMs
  }
  for (const i of items) await walk(join(root, i))
  return { files, modified }
}

const backupDir = (savesRoot: string, t: SaveTarget): string => join(savesRoot, 'backups', t.emulator, t.key)

async function listBackups(dir: string): Promise<BackupInfo[]> {
  const out: BackupInfo[] = []
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (!n.endsWith('.zip')) continue
    const s = await stat(join(dir, n)).catch(() => null)
    if (s) out.push({ name: n, at: s.mtimeMs, size: s.size })
  }
  return out.sort((a, b) => b.at - a.at)
}

export async function saveInfo(db: DatabaseSync, savesRoot: string, entry: EntryRef): Promise<SaveInfo | null> {
  const t = await resolveTarget(db, savesRoot, entry)
  if (!t) return null
  const { files, modified } = await newest(t.root, t.items)
  return { emulator: t.emulator, scope: t.scope, files, modified, location: locationOf(t), backups: await listBackups(backupDir(savesRoot, t)) }
}

/** bsdtar (livré avec Windows 10+) crée et lit les zip. */
const tarExe = (): string => join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')

function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(tarExe(), args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar a échoué (${code}) : ${err.trim().slice(0, 300)}`))))
  })
}

const stamp = (d = new Date()): string => {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Supprime les copies au-delà de MAX_BACKUPS (les plus anciennes d'abord). */
async function prune(dir: string): Promise<void> {
  for (const b of (await listBackups(dir)).slice(MAX_BACKUPS)) await rm(join(dir, b.name), { force: true })
}

/**
 * Copie les sauvegardes dans un zip daté. `onlyIfChanged` : rien n'est fait si aucun fichier n'a changé depuis la dernière copie
 * (utilisé après chaque partie). Renvoie null s'il n'y avait rien à copier.
 */
export async function backupSaves(db: DatabaseSync, savesRoot: string, entry: EntryRef, onlyIfChanged = false, prune_ = true): Promise<BackupInfo | null> {
  const t = await resolveTarget(db, savesRoot, entry)
  if (!t || !t.items.length) return null
  const dir = backupDir(savesRoot, t)
  const { modified } = await newest(t.root, t.items)
  if (modified === null) return null
  const last = (await listBackups(dir))[0]
  if (onlyIfChanged && last && last.at >= modified) return null
  await mkdir(dir, { recursive: true })
  let name = `${stamp()}.zip`
  // Deux copies dans la même seconde : le nom reste unique.
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${stamp()}-${n}.zip`
  await tar(['-a', '-cf', join(dir, name), '-C', t.root, ...t.items])
  if (prune_) await prune(dir)
  const s = await stat(join(dir, name))
  return { name, at: s.mtimeMs, size: s.size }
}

/** Restaure une copie par-dessus les fichiers actuels, après avoir mis les fichiers actuels de côté dans une nouvelle copie. */
export async function restoreSaves(db: DatabaseSync, savesRoot: string, entry: EntryRef, name: string): Promise<boolean> {
  const t = await resolveTarget(db, savesRoot, entry)
  if (!t || basename(name) !== name || !name.endsWith('.zip')) return false
  const file = join(backupDir(savesRoot, t), name)
  if (!existsSync(file)) return false
  // Pas d'élagage avant l'extraction : la copie à restaurer pourrait être la plus ancienne.
  await backupSaves(db, savesRoot, entry, false, false).catch(() => null)
  await mkdir(t.root, { recursive: true })
  await tar(['-xf', file, '-C', t.root])
  await prune(backupDir(savesRoot, t))
  return true
}

/** Supprime toutes les copies (jeu ou émulateur, selon la portée) ; renvoie leur nombre. */
export async function deleteAllBackups(db: DatabaseSync, savesRoot: string, entry: EntryRef): Promise<number> {
  const t = await resolveTarget(db, savesRoot, entry)
  if (!t) return 0
  const dir = backupDir(savesRoot, t)
  const all = await listBackups(dir)
  for (const b of all) await rm(join(dir, b.name), { force: true })
  return all.length
}

export async function deleteBackup(db: DatabaseSync, savesRoot: string, entry: EntryRef, name: string): Promise<void> {
  const t = await resolveTarget(db, savesRoot, entry)
  if (t && basename(name) === name && name.endsWith('.zip')) await rm(join(backupDir(savesRoot, t), name), { force: true })
}

/** Ce qu'il faut montrer dans l'Explorateur : le fichier du jeu sélectionné dans son dossier (`select`), sinon le dossier lui-même. */
export async function saveOpenTarget(db: DatabaseSync, savesRoot: string, entry: EntryRef): Promise<{ path: string; select: boolean } | null> {
  const t = await resolveTarget(db, savesRoot, entry)
  if (!t) return null
  if (t.scope === 'game' && t.items.length) return { path: join(t.root, t.items[0]), select: true }
  const loc = locationOf(t)
  return loc ? { path: loc, select: false } : null
}

/** Supprime les sauvegardes propres à ce jeu (RetroArch, melonDS) ; les émulateurs qui mélangent tous leurs jeux ne sont pas touchés. */
export async function deleteGameSaves(db: DatabaseSync, savesRoot: string, entry: EntryRef): Promise<void> {
  const t = await resolveTarget(db, savesRoot, entry)
  if (t?.scope === 'game') for (const i of t.items) await rm(join(t.root, i), { recursive: true, force: true })
}

/**
 * RetroArch : range sauvegardes et états dans le dossier de données de RomVault (par jeu, hors de l'installation).
 * Les fichiers déjà présents dans les anciens dossiers de l'installation y sont recopiés une fois.
 */
export async function prepareRetroarch(dir: string, savesRoot: string): Promise<void> {
  const cfg = join(dir, 'retroarch.cfg')
  const root = retroarchSavesRoot(savesRoot)
  const wanted = { savefile_directory: join(root, 'saves'), savestate_directory: join(root, 'states') }
  if (!existsSync(join(root, 'saves'))) {
    await mkdir(root, { recursive: true })
    await cp(join(dir, 'saves'), wanted.savefile_directory, { recursive: true, force: false }).catch(() => {})
    await cp(join(dir, 'states'), wanted.savestate_directory, { recursive: true, force: false }).catch(() => {})
  }
  await mkdir(wanted.savefile_directory, { recursive: true })
  await mkdir(wanted.savestate_directory, { recursive: true })
  const text = existsSync(cfg) ? await readFile(cfg, 'utf8') : ''
  const next = patchCfg(text, wanted)
  if (next !== text) await writeFile(cfg, next)
}
