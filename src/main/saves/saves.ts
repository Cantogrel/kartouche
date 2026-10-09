import type { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { emulatorForConsole } from '@shared/emulators'
import { MAX_BACKUPS, type BackupInfo, type SaveInfo } from '@shared/saves'
import { getRow } from '../emulators/emulatorStore'
import { patchCfg } from '../emulators/configure'
import { identifyGame } from './identify'
import { pcsx2CardNames } from '../emulators/pcsx2Cards'
import { ps1CardSerials } from '../emulators/duckstation'

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

/** `titleId` / `vitaTitleId` : colonnes `title_id` et `vita_title_id` de la bibliothèque (Switch, 3DS ; Vita). */
export interface EntryRef { id: number; console: string; path: string; titleId?: string | null; vitaTitleId?: string | null; gameKey?: string | null }

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

/** État des sauvegardes de jeux de Cemu (dossier `usr/save/<haut>/<bas>` → date de modification la plus récente) : sert à reconnaître celui qu'une partie a touché. */
export async function snapshotCemuSaves(mlc: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const base = join(mlc, 'usr', 'save')
  for (const hi of await readdir(base).catch(() => [] as string[])) {
    // Seuls les titres de jeu (00050000 : disque et eShop, 00050002 : démo) ont une sauvegarde de jeu ; « system » (comptes, journal de jeu) et 00050010 (applications système,
    // vérifié : le menu de la Wii U y écrit dès le démarrage de Cemu) n'appartiennent à aucun jeu.
    if (!/^0005000[02]$/i.test(hi)) continue
    for (const lo of await readdir(join(base, hi)).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{8}$/i.test(lo)) continue
      out.set(`${hi}${lo}`.toUpperCase(), (await newest(base, [join(hi, lo)])).modified ?? 0)
    }
  }
  return out
}

/**
 * Title ID d'un jeu Wii U dont le fichier ne le livre pas (archive, clé de disque inconnue), d'après la partie qui vient de se terminer : le seul dossier de
 * sauvegarde créé ou modifié depuis `before`. Plusieurs candidats (ou aucun) : on n'en retient aucun plutôt que de risquer de mélanger deux jeux.
 */
export async function learnCemuKey(db: DatabaseSync, entryId: number, mlc: string, before: Map<string, number>): Promise<string | null> {
  const after = await snapshotCemuSaves(mlc)
  const touched = [...after].filter(([id, t]) => t > (before.get(id) ?? -1)).map(([id]) => id)
  if (touched.length !== 1) return null
  db.prepare('UPDATE library SET game_key = ? WHERE id = ?').run(touched[0], entryId)
  return touched[0]
}

/** Entrées de `dir` (fichiers ou dossiers) dont le nom commence par `prefix`, en chemins relatifs à la racine (`rel`). */
const startingWith = async (rel: string, root: string, prefix: string): Promise<string[]> =>
  (await readdir(join(root, rel)).catch(() => [] as string[])).filter((n) => n.startsWith(prefix)).map((n) => join(rel, n))

/** Dossier `mlc01` de Cemu : celui de `settings.xml` (<mlc_path>) s'il y en a un, sinon à côté de l'exécutable (mode portable de Kartouche). */
export async function cemuMlcDir(dir: string): Promise<string> {
  const xml = await readFile(join(dir, 'settings.xml'), 'utf8').catch(() => '')
  const custom = /<mlc_path>\s*([^<]*?)\s*<\/mlc_path>/.exec(xml)?.[1]
  return custom && isAbsolute(custom) ? custom : join(dir, 'mlc01')
}

/**
 * Sauvegardes d'un jeu précis, d'après son identifiant et la façon dont l'émulateur les nomme (relevé dans son code source officiel) :
 * - DuckStation : `savestates/<SERIE>_<n>.sav` (System::GetGameSaveStatePath), `memcards/<SERIE>_<n>.mcd` (carte « PerGame », voir applyDuckstationGame) ;
 * - PCSX2 : états `sstates/<SERIE> (<CRC>).<n>.p2s` (VMManager.cpp), cartes mémoire dédiées `memcards/RomVault-<SERIE>[-2]` (voir pcsx2Cards.ts) ;
 * - Cemu : dossier `usr/save/<TitleID haut>/<TitleID bas>` du `mlc01` (nn_save.cpp) ; la mise à jour et les DLC d'un jeu partagent ce Title ID de base, et
 *   `usr/save/system` (comptes, journal de jeu) n'appartient à aucun jeu ;
 * - Azahar : `user/states/<TitleID 16 hex>.<n>.cst` (savestate.cpp), `user/sdmc/Nintendo 3DS/<32 zéros>/<32 zéros>/title/<haut>/<bas>/data` (archive_source_sd_savedata.cpp) ;
 * - Eden : `user/nand/user/save/0000000000000000/<utilisateur>/<TitleID 16 hex>` (savedata_factory.cpp) ;
 * - RPCS3 : dossiers `dev_hdd0/home/<utilisateur>/savedata/<TITLE_ID>…` (cellSaveData.cpp filtre sur ce préfixe) ; pas de sauvegarde d'état ;
 * - PPSSPP : `memstick/PSP/SAVEDATA/<DISC_ID>…` (préfixe imposé aux jeux), `memstick/PSP/PPSSPP_STATE/<DISC_ID>_<version>_<n>.ppst` (SaveState.cpp) ;
 * - Vita3K : `ux0/user/00/savedata/<TitleID>` (io.cpp).
 */
async function gameScopedItems(id: string, root: string, key: string, entry: EntryRef): Promise<string[]> {
  if (id === 'duckstation') {
    // États : `<SERIE>_<n>.sav`. Cartes : par défaut DuckStation en donne une à chaque jeu, nommée d'après son titre (« PerGameTitle ») — on la reconnaît à ses sauvegardes
    // (nom « B » + région + numéro de série) ; les cartes partagées (`shared_card_<n>.mcd`) mêlent tous les jeux et ne sont à aucun.
    const cards: string[] = await startingWith('memcards', root, `${key}_`)
    for (const n of await readdir(join(root, 'memcards')).catch(() => [] as string[])) {
      const rel = join('memcards', n)
      if (!/\.mcd$/i.test(n) || /^shared_card_/i.test(n) || cards.includes(rel)) continue
      if (ps1CardSerials(await readFile(join(root, rel)).catch(() => Buffer.alloc(0))).includes(key)) cards.push(rel)
    }
    return [...await startingWith('savestates', root, `${key}_`), ...cards]
  }
  if (id === 'pcsx2') {
    const own = [...pcsx2CardNames(key), ...pcsx2CardNames(`g${entry.id}`)].filter((n) => existsSync(join(root, 'memcards', n))).map((n) => join('memcards', n))
    return [...await startingWith('sstates', root, `${key} (`), ...own]
  }
  if (id === 'ppsspp') return [...await startingWith(join('memstick', 'PSP', 'SAVEDATA'), root, key), ...await startingWith(join('memstick', 'PSP', 'PPSSPP_STATE'), root, `${key}_`)]
  if (id === 'rpcs3') {
    const homes = join('dev_hdd0', 'home')
    const out: string[] = []
    for (const u of await readdir(join(root, homes)).catch(() => [] as string[])) out.push(...await startingWith(join(homes, u, 'savedata'), root, key))
    return out
  }
  if (id === 'azahar') {
    const tid = key.toUpperCase()
    if (!/^[0-9A-F]{16}$/.test(tid)) return []
    const zeros = '0'.repeat(32)
    const data = join('user', 'sdmc', 'Nintendo 3DS', zeros, zeros, 'title', tid.slice(0, 8).toLowerCase(), tid.slice(8).toLowerCase(), 'data')
    return [...await startingWith(join('user', 'states'), root, `${tid}.`), ...(existsSync(join(root, data)) ? [data] : [])]
  }
  if (id === 'eden') {
    const tid = key.toUpperCase()
    if (!/^[0-9A-F]{16}$/.test(tid)) return []
    const base = join('user', 'nand', 'user', 'save', '0000000000000000')
    return (await readdir(join(root, base)).catch(() => [] as string[])).map((u) => join(base, u, tid)).filter((p) => existsSync(join(root, p)))
  }
  if (id === 'vita3k') return startingWith(join('ux0', 'user', '00', 'savedata'), root, key)
  if (id === 'dolphin') return dolphinGameItems(root, key)
  return []
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
  const rels = EMULATOR_SAVE_DIRS[def.id]
  if (!row || !rels) return null
  // Un jeu identifiable a ses propres sauvegardes. Seul un jeu dont l'identifiant est introuvable (format illisible, jamais lancé) retombe sur la portée émulateur.
  const key = await identifyGame(db, entry, { cemuDir: def.id === 'cemu' ? row.dir : undefined })
  if (key) {
    if (def.id === 'cemu') {
      const tid = key.toUpperCase()
      const own = /^[0-9A-F]{16}$/.test(tid) ? join('usr', 'save', tid.slice(0, 8).toLowerCase(), tid.slice(8).toLowerCase()) : null
      const mlc = await cemuMlcDir(row.dir)
      return { emulator: def.id, scope: 'game', key: `g${entry.id}`, root: mlc, items: own && existsSync(join(mlc, own)) ? [own] : [], dirs: [join(mlc, 'usr', 'save')] }
    }
    return { emulator: def.id, scope: 'game', key: `g${entry.id}`, root: row.dir, items: await gameScopedItems(def.id, row.dir, key, entry), dirs: rels.map((r) => join(row.dir, r)) }
  }
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
 * RetroArch : range sauvegardes et états dans le dossier de données de Kartouche (par jeu, hors de l'installation).
 * Les fichiers déjà présents dans les anciens dossiers de l'installation y sont recopiés une fois.
 */
export async function prepareRetroarch(dir: string, savesRoot: string, padSlot: number | null = null, nintendo: { port: number } | null = null, players: { driver: 'xinput' | 'sdl2'; indexes: number[] } | null = null): Promise<void> {
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
  // Manette du joueur 1 : celle sur laquelle on vient d'appuyer (pilote XInput de RetroArch : l'indice est l'emplacement XInput). Switch Pro ou paire de Joy-Con : pilote SDL2 (leurs profils
  // `autoconfig/sdl2` sont fournis), lancé avec les seuls pilotes HIDAPI visibles (voir `emulatorEnv`) : l'indice est alors le rang parmi les manettes Nintendo. Le pilote n'est changé que s'il
  // est l'un des deux de Kartouche (un autre, choisi par l'utilisateur, reste).
  const driver = /^input_joypad_driver\s*=\s*"?(\w+)"?\s*$/m.exec(text)?.[1] ?? 'xinput'
  const ours = driver === 'xinput' || driver === 'sdl2'
  // Plusieurs joueurs : pilote commun et un rang de manette par joueur (`input_player<n>_joypad_index`).
  const multi: Record<string, string | number> = players && players.indexes.length >= 2 && ours ? { input_joypad_driver: players.driver, ...Object.fromEntries(players.indexes.map((i, n) => [`input_player${n + 1}_joypad_index`, i])) } : {}
  const pad: Record<string, string | number> = players && players.indexes.length >= 2 && ours ? multi : nintendo && ours ? { input_joypad_driver: 'sdl2', input_player1_joypad_index: nintendo.port } : padSlot === null ? (driver === 'sdl2' ? { input_joypad_driver: 'xinput' } : {}) : { ...(driver === 'sdl2' ? { input_joypad_driver: 'xinput' } : {}), input_player1_joypad_index: padSlot }
  // Stick gauche aussi sur la croix (« Analog to Digital Type » = Left Analog) : sans lui, la plupart des jeux 2D (SNES, GB…) ne répondent qu'à la croix. Sans effet sur les cœurs à manette analogique (N64),
  // où le stick reste analogique. Écrit une seule fois (marqueur) : un choix fait ensuite dans RetroArch n'est pas refait à chaque lancement.
  const stickMarker = join(dir, 'romvault-analog-dpad')
  const stick: Record<string, string | number> = existsSync(stickMarker) ? {} : { input_player1_analog_dpad_mode: 1 }
  // Joueurs 2 à 4 (ajoutés après le joueur 1) : même réglage, une seule fois aussi (autre marqueur).
  const stickMarkerOthers = join(dir, 'romvault-analog-dpad-2-4')
  const stickOthers: Record<string, string | number> = existsSync(stickMarkerOthers) ? {} : { input_player2_analog_dpad_mode: 1, input_player3_analog_dpad_mode: 1, input_player4_analog_dpad_mode: 1 }
  const next = patchCfg(text, { ...wanted, ...pad, ...stick, ...stickOthers })
  if (next !== text) await writeFile(cfg, next)
  if (!existsSync(stickMarker)) await writeFile(stickMarker, '').catch(() => {})
  if (!existsSync(stickMarkerOthers)) await writeFile(stickMarkerOthers, '').catch(() => {})
}
