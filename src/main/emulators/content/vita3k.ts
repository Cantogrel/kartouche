import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { parsePkgHeader } from '../../library/content/pkg'
import { readVitaArchive } from '../../library/content/vita'
import { backupFiles, diffTrees, expandCreatedRoots, snapshotTrees } from './snapshot'
import type { ContentInstaller, InstallEnv } from './types'

// Vita3K : trois chemins d'installation, tous vérifiés dans son code source (Vita3K/vita3k : `interface.cpp`, `main.cpp`, `config.cpp`, `packages/src/pkg.cpp`, `io/src/io.cpp`) :
//  1. archive `.vpk`/`.zip` (PARAM.SFO en clair) : `Vita3K.exe <archive>` — installe selon CATEGORY : `ac` (DLC) → `ux0/addcont/<TITLE_ID>/<fin du CONTENT_ID>`, `gp` (mise à jour) → extraite
//     dans `ux0/patch/<TITLE_ID>` puis FUSIONNÉE dans `ux0/app/<TITLE_ID>` (copy_path) où elle écrase les fichiers du jeu ; exige que le jeu soit déjà installé (« Install app before patch »).
//     La fenêtre de Vita3K s'ouvre ensuite : comme pour un jeu .vpk, on lit son journal (« [<TITLE_ID>] installed successfully! ») puis on la ferme.
//     Aucune clé à fournir (le contenu NoNpDrm porte son work.bin, ou la licence du jeu installé sert).
//  2. paquet `.pkg` DLC : `Vita3K.exe --pkg <fichier> --zrif <zRIF>` (headless : Vita3K se referme seul) — le zRIF est une donnée de l'UTILISATEUR, lue dans un fichier voisin
//     `<nom>.pkg.zrif` ou `<nom>.zrif` ; jamais deviné, jamais téléchargé.
//  3. paquet `.pkg` de MISE À JOUR : non pris en charge (limite technique réelle, voir `install`).

/** Dossier de données de Vita3K (celui qui contient `ux0/`) : `pref-path` de son config.yml, sinon l'emplacement par défaut de Windows. */
export async function vita3kPrefPath(exeDir: string): Promise<string> {
  const cfg = await readFile(join(exeDir, 'config.yml'), 'utf8').catch(() => '')
  const m = /^pref-path:\s*(.+?)\s*$/m.exec(cfg)
  const v = m?.[1].replace(/^["']|["']$/g, '')
  return v ? v : join(homedir(), 'AppData', 'Roaming', 'Vita3K', 'Vita3K')
}

const INSTALL_TIMEOUT_MS = 10 * 60_000
const PKG_TIMEOUT_MS = 30 * 60_000

const killTree = (pid: number | undefined): void => { if (pid) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined) }

/** Lance Vita3K sur une archive, attend le verdict de son journal (sortie standard), puis ferme sa fenêtre. */
async function runArchiveInstall(exe: string, cwd: string, archive: string, titleId: string): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolveRun) => {
    let log = ''
    let done = false
    const child = spawn(exe, [archive], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const finish = (ok: boolean): void => { if (done) return; done = true; clearTimeout(timer); killTree(child.pid); resolveRun({ ok, log }) }
    const onData = (b: Buffer): void => {
      log += b.toString('utf8')
      if (new RegExp(`\\[${titleId}\\] installed successfully!`).test(log)) finish(true)
      else if (/Install app before patch|NoNpDrm installation failed|miniz error|Failed to copy directory|already installed, skipping/i.test(log)) finish(false)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', () => finish(false))
    const timer = setTimeout(() => finish(false), INSTALL_TIMEOUT_MS)
  })
}

const inside = (p: string, root: string): boolean => resolve(p).toLowerCase().startsWith(resolve(root).toLowerCase() + sep)

async function sidecarZrif(pkg: string): Promise<string | null> {
  for (const f of [`${pkg}.zrif`, join(dirname(pkg), `${basename(pkg, extname(pkg))}.zrif`)]) {
    const text = (await readFile(f, 'utf8').catch(() => '')).trim()
    if (/^[A-Za-z0-9+/=_-]{20,4096}$/.test(text)) return text
  }
  return null
}

async function nonEmptyDir(p: string): Promise<boolean> { return (await readdir(p).catch(() => [] as string[])).length > 0 }

async function installPkg(env: InstallEnv, item: { path: string; kind: 'update' | 'dlc' }, baseKey: string, runPkg: Vita3kRunners['pkg']): Promise<ReturnType<ContentInstaller['install']>> {
  if (item.kind === 'update') {
    // Limite technique réelle : un paquet de mise à jour est fusionné dans le dossier du jeu (copy_path, io.cpp) et ses fichiers ne sont lisibles qu'une fois sa couche PFS déchiffrée
    // avec le zRIF — impossible de savoir d'avance lesquels il écrasera, donc de les sauvegarder pour pouvoir défaire l'installation. Une mise à jour installée sans cela ne pourrait pas
    // être retirée : elle n'est donc pas installée. L'archive .vpk/.zip de la même mise à jour (PARAM.SFO lisible) l'est.
    return { state: 'pending', reason: 'unsupported', detail: 'mise à jour en .pkg : fusionnée dans le jeu sans moyen de la défaire — utiliser son archive .vpk/.zip' }
  }
  const zrif = await sidecarZrif(item.path)
  if (!zrif) return { state: 'pending', reason: 'needsKey', detail: 'zRIF requis : le placer dans un fichier « <nom>.pkg.zrif » à côté du paquet (jamais téléchargé ni deviné)' }
  const fh = await open(item.path, 'r')
  let contentId = ''
  try { const b = Buffer.alloc(64 * 1024); const { bytesRead } = await fh.read(b, 0, b.length, 0); contentId = parsePkgHeader(b.subarray(0, bytesRead))?.contentId ?? '' } finally { await fh.close() }
  if (contentId.length < 36) return { state: 'failed', reason: 'error', detail: 'identifiant de contenu du paquet illisible' }
  const pref = await vita3kPrefPath(env.emulator!.dir)
  const roots = [join(pref, 'ux0', 'addcont', baseKey), join(pref, 'ux0', 'license', baseKey)]
  const before = await snapshotTrees(roots)
  const exit = await runPkg(env.emulator!.exe, env.emulator!.dir, item.path, zrif)
  const diff = await diffTrees(before, roots)
  const emuFiles = await expandCreatedRoots(diff.created, roots)
  const dlcDir = join(pref, 'ux0', 'addcont', baseKey, contentId.slice(20))
  if (exit !== 0 || !(await nonEmptyDir(dlcDir))) return { state: 'failed', reason: 'error', detail: 'installation du paquet non confirmée (dossier du DLC absent ou vide)', emuFiles }
  return { state: 'installed', emuFiles }
}

export interface Vita3kRunners {
  /** Installe une archive (journal attendu puis fenêtre fermée) : vrai si Vita3K a confirmé l'installation. */
  archive: (exe: string, cwd: string, archive: string, titleId: string) => Promise<{ ok: boolean; log: string }>
  /** `Vita3K --pkg … --zrif …` : code de sortie (null : n'a pas terminé). */
  pkg: (exe: string, cwd: string, pkg: string, zrif: string) => Promise<number | null>
}

const defaultRunners: Vita3kRunners = {
  archive: runArchiveInstall,
  pkg: (exe, cwd, pkg, zrif) => new Promise<number | null>((resolveExit) => {
    const child = spawn(exe, ['--pkg', pkg, '--zrif', zrif], { cwd, stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { child.kill(); resolveExit(null) }, PKG_TIMEOUT_MS)
    child.on('error', () => { clearTimeout(timer); resolveExit(null) })
    child.on('exit', (code) => { clearTimeout(timer); resolveExit(code) })
  })
}

export function makeVita3kInstaller(runners: Vita3kRunners = defaultRunners): ContentInstaller {
  return {
  emulatorId: 'vita3k',
  managed: false,
  async install(env, item, game, when) {
    if (!env.emulator) return { state: 'pending', reason: 'emulatorMissing' }
    if (!existsSync(item.path)) return { state: 'failed', reason: 'error', detail: 'fichier absent' }
    const ext = extname(item.path).toLowerCase()
    if (ext !== '.vpk' && ext !== '.zip' && ext !== '.pkg') return { state: 'failed', reason: 'error', detail: 'format non pris en charge par Vita3K' }
    if (ext === '.pkg') {
      if (await env.isRunning('Vita3K.exe')) return { state: 'pending', reason: 'emulatorRunning' }
      return installPkg(env, item, game.baseKey, runners.pkg)
    }
    // L'installation d'une archive ouvre la fenêtre de Vita3K : seulement au lancement du jeu, comme pour un .cia.
    if (when === 'import') return { state: 'pending', reason: 'onLaunch' }
    if (await env.isRunning('Vita3K.exe')) return { state: 'pending', reason: 'emulatorRunning' }
    const info = await readVitaArchive(item.path)
    if (!info || info === 'many') return { state: 'failed', reason: 'error', detail: 'archive illisible (PARAM.SFO introuvable ou plusieurs contenus)' }
    // Garde-fou : le contenu doit appartenir à CE jeu (l'import l'a déjà vérifié ; on ne se fie pas à une ligne de base de données).
    if (game.baseKey && info.titleId !== game.baseKey) return { state: 'failed', reason: 'error', detail: `l'archive est celle du jeu ${info.titleId}, pas de ${game.baseKey}` }
    if (info.category !== 'gp' && info.category !== 'ac') return { state: 'failed', reason: 'error', detail: `catégorie Vita non installable (${info.category})` }
    const pref = await vita3kPrefPath(env.emulator.dir)
    const ux0 = join(pref, 'ux0')
    const appDir = join(ux0, 'app', info.titleId)
    // Une mise à jour se fusionne dans le jeu : il doit déjà être installé dans Vita3K (il l'est au premier lancement du jeu).
    if (info.category === 'gp' && !(await nonEmptyDir(appDir))) return { state: 'pending', reason: 'onLaunch', detail: "le jeu n'est pas encore installé dans Vita3K" }
    const noNpDrm = info.entries.some((e) => /^sce_sys\/package\//i.test(e.name))
    const roots = info.category === 'gp'
      ? [appDir, join(ux0, 'patch', info.titleId), join(ux0, 'license', info.titleId)]
      : [join(ux0, 'addcont', info.titleId), join(ux0, 'license', info.titleId)]
    // Une mise à jour ÉCRASE des fichiers du jeu : on garde l'original de chacun (hors de Vita3K) pour pouvoir la défaire.
    const backupDir = join(dirname(env.romsDir), 'content-backups', 'vita3k', String(item.id))
    const wanted = info.entries.map((e) => e.name)
    const backups = info.category === 'gp' ? await backupFiles(wanted.map((rel) => join(appDir, ...rel.split('/'))), appDir, backupDir) : {}
    const before = await snapshotTrees(roots)
    const run = await runners.archive(env.emulator.exe, env.emulator.dir, item.path, info.titleId)
    const diff = await diffTrees(before, roots)
    const restoreAll = async (): Promise<void> => { for (const [t, b] of Object.entries(backups)) await copyFile(b, t).catch(() => undefined) }
    const unsaved = diff.modified.filter((m) => !Object.keys(backups).some((t) => resolve(t).toLowerCase() === resolve(m).toLowerCase()))
    if (unsaved.length) {
      // Un fichier du jeu a été réécrit sans qu'on en ait gardé l'original (jamais censé arriver) : on remet ce qu'on a et on n'annonce rien d'installé.
      await restoreAll()
      return { state: 'failed', reason: 'error', detail: `installation annulée : ${unsaved.length} fichier(s) du jeu réécrits sans sauvegarde` }
    }
    const emuFiles = await expandCreatedRoots(diff.created, roots)
    if (!run.ok) {
      await restoreAll()
      for (const c of emuFiles) if (inside(c, ux0)) await rm(c, { recursive: true, force: true }).catch(() => undefined)
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
      return { state: 'failed', reason: 'error', detail: 'installation refusée par Vita3K (voir son journal)' }
    }
    // Contrôle indépendant du journal : chaque fichier de l'archive doit être à sa place (la taille n'est comparée que hors NoNpDrm, dont le déchiffrement la change).
    const dest = info.category === 'gp' ? appDir : join(ux0, 'addcont', info.titleId, info.contentId.slice(20))
    for (const e of info.entries) {
      if (/^sce_sys\/package\//i.test(e.name)) continue
      const st = await stat(join(dest, ...e.name.split('/'))).catch(() => null)
      if (!st || (!noNpDrm && st.size !== e.size)) return { state: 'failed', reason: 'error', emuFiles, emuBackups: backups, detail: `installation incomplète (fichier manquant ou tronqué : ${e.name})` }
    }
    return { state: 'installed', emuFiles, emuBackups: Object.keys(backups).length ? backups : undefined }
  },
  async uninstall(env, items) {
    if (!env.emulator) return { ok: true }
    if (await env.isRunning('Vita3K.exe')) return { ok: false, detail: 'Vita3K est ouvert : le fermer avant de désinstaller' }
    const pref = await vita3kPrefPath(env.emulator.dir)
    const ux0 = join(pref, 'ux0')
    const removed: string[] = []
    let leftover = false
    for (const it of items) {
      // Mises à jour empilées : chacune a écrasé ce que la précédente avait laissé. Seule la plus récente peut être défaite sans casser les autres.
      if (it.kind === 'update' && it.emuBackups && (it.siblings ?? []).some((s) => s.kind === 'update' && (s.installedAt ?? 0) > (it.installedAt ?? 0))) {
        return { ok: false, detail: "une mise à jour plus récente est installée : la désinstaller d'abord" }
      }
      const backups = it.emuBackups ?? {}
      for (const [target, backup] of Object.entries(backups)) if (!inside(target, ux0) || !existsSync(backup)) return { ok: false, detail: "copie de sauvegarde d'origine introuvable : désinstallation refusée (rien n'a été modifié)" }
      if (!it.emuFiles) { leftover = true; continue } // jamais installé par RomVault avec suivi : rien ne prouve ce qui lui appartient
      if (it.emuFiles.length === 0 && Object.keys(backups).length === 0) { leftover = true; continue }
      for (const [target, backup] of Object.entries(backups)) { await copyFile(backup, target); removed.push(target) }
      for (const p of it.emuFiles) {
        if (!inside(p, ux0)) continue // jamais en dehors de ux0, même avec un chemin enregistré piégé
        await rm(p, { recursive: true, force: true })
        removed.push(p)
        // Dossiers parents (addcont/<TITLE_ID>, puis addcont) seulement s'ils sont devenus vides : rmdir refuse un dossier non vide, donc jamais le jeu ni le contenu d'un autre.
        for (const parent of [dirname(p), dirname(dirname(p))]) if (inside(parent, ux0)) await rmdir(parent).catch(() => undefined)
      }
      if (Object.keys(backups).length) await rm(join(dirname(env.romsDir), 'content-backups', 'vita3k', String(it.id)), { recursive: true, force: true }).catch(() => undefined)
    }
    return { ok: true, leftover: leftover ? 'Vita3K' : undefined, removed }
  }
}
}

export const vita3kInstaller: ContentInstaller = makeVita3kInstaller()
