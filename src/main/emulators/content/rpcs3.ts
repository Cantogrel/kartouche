import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { copyFile } from 'node:fs/promises'
import { backupFiles } from './snapshot'
import { listPkgFiles } from '../../library/content/pkgFiles'
import type { ContentInstaller } from './types'

const INSTALL_TIMEOUT_MS = 20 * 60_000

const rpcs3Log = (dir: string): string => join(dir, 'log', 'RPCS3.log')

/**
 * Verdict de RPCS3 sur un paquet, d'après les lignes qu'il écrit lui-même à la fin d'une installation (rpcs3qt/main_window.cpp,
 * `HandlePackageInstallation`) : « Successfully installed <chemin> », « Failed to install », « Partially installed », « Aborted installation ».
 */
export function pkgVerdict(log: string, file: string): 'ok' | 'failed' | 'unknown' {
  const name = basename(file).toLowerCase()
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.toLowerCase()
    if (!line.includes(name)) continue
    if (line.includes('successfully installed')) return 'ok'
    if (/failed to install|partially installed|aborted installation|cannot install invalid package/.test(line)) return 'failed'
  }
  return 'unknown'
}

const gameRoot = (dir: string): string => join(dir, 'dev_hdd0', 'game')

interface Snapshot { top: Set<string>; files: Map<string, string> }

async function listFiles(dir: string, out: Map<string, string>): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await listFiles(p, out)
    else { const st = await stat(p).catch(() => null); if (st) out.set(p, `${st.size}:${Math.round(st.mtimeMs)}`) }
  }
}

/**
 * Photographie de `dev_hdd0/game` : les dossiers de premier niveau (un paquet qui crée son dossier de jeu y apparaît) et, pour le jeu concerné,
 * chaque fichier (un DLC qui s'ajoute à un dossier existant n'y crée que de nouveaux fichiers). Comparer avant/après dit exactement ce que le paquet a écrit.
 */
export async function snapshotGameData(dir: string, serial: string): Promise<Snapshot> {
  const root = gameRoot(dir)
  const names = await readdir(root).catch(() => [] as string[])
  const files = new Map<string, string>()
  if (serial) for (const n of names) if (n.toUpperCase() === serial.toUpperCase()) await listFiles(join(root, n), files)
  return { top: new Set(names.map((n) => n.toUpperCase())), files }
}

/**
 * Ce que l'installation a CRÉÉ depuis `before` (dossiers entiers nouveaux, fichiers nouveaux des dossiers déjà là) et ce qu'elle a seulement RÉÉCRIT (fichiers déjà présents dont la
 * taille ou la date a changé). Les seconds ne sont jamais à RomVault : ils appartiennent au jeu ou à un autre contenu, qu'une désinstallation ne doit pas toucher.
 */
export async function diffGameDataFull(dir: string, serial: string, before: Snapshot): Promise<{ created: string[]; modified: string[] }> {
  const root = gameRoot(dir)
  const after = await snapshotGameData(dir, serial)
  const created: string[] = []
  const modified: string[] = []
  for (const n of await readdir(root).catch(() => [] as string[])) if (!before.top.has(n.toUpperCase())) created.push(join(root, n))
  for (const [p, sig] of after.files) {
    if (created.some((d) => p.startsWith(d + sep))) continue
    const prev = before.files.get(p)
    if (prev === undefined) created.push(p)
    else if (prev !== sig) modified.push(p)
  }
  return { created, modified }
}

/** Ce que l'installation a créé depuis `before` (voir `diffGameDataFull`). */
export async function diffGameData(dir: string, serial: string, before: Snapshot): Promise<string[]> {
  return (await diffGameDataFull(dir, serial, before)).created
}

const insideGameRoot = (dir: string, p: string): boolean => resolve(p).toLowerCase().startsWith(resolve(gameRoot(dir)).toLowerCase() + sep)

/** Marge entre les dates d'écriture des fichiers d'une installation et le moment où RomVault l'a marquée terminée (une installation de paquet peut durer plusieurs minutes). */
const WRITTEN_BEFORE_MS = 25 * 60_000
const WRITTEN_AFTER_MS = 2 * 60_000

/** Chemin absolu, dans `dev_hdd0/game`, de chaque fichier (pas dossier) qu'installerait ce paquet. */
async function pkgFilePaths(root: string, pkg: string): Promise<{ path: string; size: number }[] | null> {
  const listing = await listPkgFiles(pkg)
  if (!listing) return null
  return listing.entries.filter((e) => !e.folder).map((e) => ({ path: join(root, listing.installDir, ...e.name.split('/')), size: e.size }))
}

/**
 * RPCS3 (PS3) : les mises à jour et DLC sont des .pkg installés par `rpcs3 --headless --installpkg <fichier>` (code source : `rpcs3.cpp`, option
 * `installpkg` ; en mode `--headless` il n'y a ni fenêtre ni boîte de confirmation, contrairement au mode graphique qui ouvre l'assistant d'installation).
 * RPCS3 range lui-même le contenu sous `dev_hdd0/game/<dossier d'installation>` et le jeu en profite au lancement.
 *
 * Suivi : photographie de `dev_hdd0/game` avant et après ; seuls les fichiers CRÉÉS appartiennent à RomVault (RPCS3 n'écrase d'ailleurs un fichier existant que si le paquet
 * le demande). L'installation n'est annoncée terminée que si TOUS les fichiers du paquet sont présents (liste lue dans le paquet) : sinon elle reste « en échec ».
 *
 * NON VALIDÉ sur un vrai paquet (aucun .pkg de test disponible) : la commande, les lignes de verdict et le format du paquet viennent du code source de RPCS3, pas d'un essai réel.
 */
/** Lance `rpcs3 --headless --installpkg` et renvoie son code de sortie (null : n'a pas terminé). Remplaçable dans les tests. */
const runInstallPkg = (exe: string, cwd: string, pkg: string): Promise<number | null> => new Promise<number | null>((resolveExit) => {
  const child = spawn(exe, ['--headless', '--installpkg', pkg], { cwd, stdio: 'ignore', windowsHide: true })
  const timer = setTimeout(() => { child.kill(); resolveExit(null) }, INSTALL_TIMEOUT_MS)
  child.on('error', () => { clearTimeout(timer); resolveExit(null) })
  child.on('exit', (code) => { clearTimeout(timer); resolveExit(code) })
})

export function makeRpcs3Installer(run: (exe: string, cwd: string, pkg: string) => Promise<number | null> = runInstallPkg): ContentInstaller {
  return {
  emulatorId: 'rpcs3',
  managed: false,
  async install(env, item, game) {
    if (!env.emulator) return { state: 'pending', reason: 'emulatorMissing' }
    if (!existsSync(item.path)) return { state: 'failed', reason: 'error', detail: 'fichier absent' }
    if (await env.isRunning('rpcs3.exe')) return { state: 'pending', reason: 'emulatorRunning' }
    const before = await snapshotGameData(env.emulator.dir, game.baseKey)
    // RPCS3 n'écrase un fichier existant que si le paquet le demande (drapeau OVERWRITE) : ceux-là sont sauvegardés AVANT, pour pouvoir être remis à la désinstallation.
    const listing = await listPkgFiles(item.path)
    const targets = listing ? listing.entries.filter((e) => !e.folder && e.overwrite).map((e) => join(gameRoot(env.emulator!.dir), listing.installDir, ...e.name.split('/'))) : []
    const backupDir = join(dirname(env.romsDir), 'content-backups', 'rpcs3', String(item.id))
    const backups = await backupFiles(targets, gameRoot(env.emulator.dir), backupDir)
    const exit = await run(env.emulator.exe, env.emulator.dir, item.path)
    const diff = await diffGameDataFull(env.emulator.dir, game.baseKey, before)
    const unsaved = diff.modified.filter((m) => !Object.keys(backups).some((t) => resolve(t).toLowerCase() === resolve(m).toLowerCase()))
    if (unsaved.length) { for (const [t, b] of Object.entries(backups)) await copyFile(b, t).catch(() => undefined); return { state: 'failed', reason: 'error', emuFiles: diff.created, detail: `${unsaved.length} fichier(s) existant(s) réécrits sans sauvegarde : originaux remis, installation non retenue` } }
    if (exit === null) return { state: 'failed', reason: 'error', detail: "RPCS3 n'a pas terminé l'installation", emuFiles: diff.created }
    const verdict = pkgVerdict(await readFile(rpcs3Log(env.emulator.dir), 'utf8').catch(() => ''), item.path)
    if (verdict !== 'ok') return { state: 'failed', reason: 'error', emuFiles: diff.created, detail: verdict === 'failed' ? 'installation refusée par RPCS3 (voir son journal)' : 'résultat non confirmé par le journal de RPCS3' }
    // Contrôle indépendant du journal : chaque fichier du paquet doit être là (et, s'il vient d'être créé, à la bonne taille).
    const expected = await pkgFilePaths(gameRoot(env.emulator.dir), item.path)
    if (expected) {
      const fresh = (p: string): boolean => diff.created.some((c) => resolve(p).toLowerCase() === resolve(c).toLowerCase() || resolve(p).toLowerCase().startsWith(resolve(c).toLowerCase() + sep))
      for (const f of expected) {
        const st = await stat(f.path).catch(() => null)
        if (!st || (fresh(f.path) && st.size !== f.size)) return { state: 'failed', reason: 'error', emuFiles: diff.created, detail: `installation incomplète (fichier manquant ou tronqué : ${basename(f.path)})` }
      }
    }
    return { state: 'installed', emuFiles: diff.created, emuBackups: Object.keys(backups).length ? backups : undefined }
  },
  async uninstall(env, items) {
    if (!env.emulator) return { ok: true }
    if (await env.isRunning('rpcs3.exe')) return { ok: false, detail: 'RPCS3 est ouvert : le fermer avant de désinstaller' }
    const root = resolve(gameRoot(env.emulator.dir)).toLowerCase()
    const removed: string[] = []
    let leftover = false
    const prune = async (p: string): Promise<void> => {
      // Dossiers parents devenus vides (jamais la racine des jeux).
      for (let d = dirname(resolve(p)); d.toLowerCase() !== root && insideGameRoot(env.emulator!.dir, d); d = dirname(d)) {
        if ((await readdir(d).catch(() => ['x'])).length > 0) break
        await rm(d, { recursive: true, force: true })
      }
    }
    const remove = async (p: string): Promise<void> => {
      if (!insideGameRoot(env.emulator!.dir, p)) return // jamais en dehors de dev_hdd0/game, même avec un chemin enregistré piégé
      await rm(p, { recursive: true, force: true })
      removed.push(p)
      await prune(p)
    }
    for (const it of items) {
      // Fichiers du jeu que le paquet avait écrasés : l'original sauvegardé est remis en place (jamais supprimé). Toutes les copies doivent exister, sinon rien n'est touché.
      const backups = it.emuBackups ?? {}
      for (const [target, backup] of Object.entries(backups)) if (!insideGameRoot(env.emulator.dir, target) || !existsSync(backup)) return { ok: false, detail: "copie de sauvegarde d'origine introuvable : désinstallation refusée (rien n'a été modifié)" }
      for (const [target, backup] of Object.entries(backups)) { await copyFile(backup, target); removed.push(target) }
      if (Object.keys(backups).length) await rm(join(dirname(env.romsDir), 'content-backups', 'rpcs3', String(it.id)), { recursive: true, force: true }).catch(() => undefined)
      // Ce que l'installation a réellement CRÉÉ (comparaison avant/après) : retiré à l'identique, rien d'autre. `[]` : rien n'appartient à RomVault.
      if (it.emuFiles) {
        if (it.emuFiles.length === 0 && Object.keys(backups).length === 0) leftover = true
        for (const p of it.emuFiles) await remove(p)
        continue
      }
      // Installé avant le suivi : la liste des fichiers du paquet (lue dans le paquet, comme RPCS3) dit ce que cette installation a écrit. Un fichier n'est retiré que s'il est encore tel
      // que l'installation l'a laissé (même taille), date de cette installation, et n'est écrit par aucun autre contenu du jeu — sinon il est conservé et signalé.
      const own = await pkgFilePaths(gameRoot(env.emulator.dir), it.path)
      if (!own || !it.installedAt) { leftover = true; continue }
      const shared = new Set<string>()
      for (const sib of it.siblings ?? []) for (const f of (await pkgFilePaths(gameRoot(env.emulator.dir), sib.path)) ?? []) shared.add(resolve(f.path).toLowerCase())
      for (const f of own) {
        const st = await stat(f.path).catch(() => null)
        if (!st) continue // déjà absent
        const mine = st.size === f.size && st.mtimeMs >= it.installedAt - WRITTEN_BEFORE_MS && st.mtimeMs <= it.installedAt + WRITTEN_AFTER_MS && !shared.has(resolve(f.path).toLowerCase())
        if (mine) await remove(f.path)
        else leftover = true
      }
    }
    return { ok: true, leftover: leftover ? 'RPCS3' : undefined, removed }
  }
}
}

export const rpcs3Installer: ContentInstaller = makeRpcs3Installer()
