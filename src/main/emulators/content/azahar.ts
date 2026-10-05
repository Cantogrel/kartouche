import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { diffTrees, expandCreatedRoots, snapshotTrees } from './snapshot'
import type { ContentInstaller, UninstallRef } from './types'

const CIA_INSTALL_TIMEOUT_MS = 120_000

/**
 * Un .cia doit être installé une fois dans le « NAND » virtuel d'Azahar avant de pouvoir être lancé (sinon : « il faut
 * d'abord l'installer »). Azahar sait le faire en ligne de commande (`-i`), mais affiche ensuite une boîte de dialogue
 * bloquante que personne ne clique jamais dans ce flux : le résultat est déjà écrit dans le journal d'Azahar avant cet
 * affichage (`Installed … successfully.`, ou une ligne d'erreur), donc on le lit là plutôt que d'attendre un clic qui
 * ne viendra pas, puis on ferme la fenêtre nous-mêmes.
 */
export async function installCia(exe: string, dir: string, ciaPath: string): Promise<boolean> {
  const log = join(dir, 'user', 'log', 'azahar_log.txt')
  // Azahar tronque/réécrit son propre journal à chaque démarrage (l'ancien est renommé en .old.txt) : comparer des
  // tailles d'octets se fait piéger dès que le nouveau contenu retombe à une taille proche de l'ancien (quasi
  // systématique ici, le message ne changeant que par ses horodatages). On compare le texte entier à la place : les
  // horodatages diffèrent toujours d'un lancement à l'autre, donc une égalité stricte veut dire « rien de nouveau ».
  const before = await readFile(log, 'utf8').catch(() => '')
  const child = spawn(exe, ['-i', ciaPath], { cwd: dir, stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + CIA_INSTALL_TIMEOUT_MS
  let outcome: boolean | null = null
  while (outcome === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    const text = await readFile(log, 'utf8').catch(() => '')
    if (text === before) continue
    if (/Service\.AM .*Installed .*successfully\./.test(text)) outcome = true
    else if (/Service\.AM .*(aborted with error code|is encrypted! Aborting)/.test(text)) outcome = false
  }
  // child.kill() n'a aucun effet sur cette boîte de dialogue Qt bloquante (constaté : le processus reste vivant) ; taskkill /F la ferme.
  if (child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  return outcome ?? false
}

/**
 * Azahar (3DS) : les mises à jour (0004000E) et DLC (0004008C) sont des .cia installés par `azahar -i`, comme un jeu .cia — Azahar les range lui-même
 * dans son NAND/SD virtuel, où il les retrouve au lancement du jeu (mise à jour appliquée automatiquement, DLC proposés au jeu). L'installation ouvre
 * brièvement la fenêtre d'Azahar : elle n'a donc lieu qu'au lancement du jeu (`launch`), jamais silencieusement pendant un import.
 */
// Désinstallation : même geste que le menu « Désinstaller » du jeu dans Azahar (citra_qt `UninstallTitles` → `Service::AM::UninstallProgram`, am.cpp) : supprimer
// le dossier `content/` du titre — « so we don't delete the user's save data », le dossier `data/` voisin (sauvegardes) est conservé. Chemins d'Azahar (am.cpp,
// `GetMediaTitlePath`/`GetTitleMediaType`) : mises à jour (0004000E) et DLC (0004008C) ne sont ni « système » ni « DLP », donc sur la carte SD virtuelle :
// `sdmc/Nintendo 3DS/<SYSTEM_ID>/<SDCARD_ID>/title/<id haut>/<id bas>/` (les deux identifiants sont 32 zéros). Le ticket écrit par l'installation du .cia
// (`GetTicketPath`, am.cpp) est `nand/dbs/ticket.db/<TITLE ID>.<TICKET ID>.tik` ; il est retiré avec le contenu (l'API `DeleteTicket` d'Azahar existe pour ça).
const ZERO_ID = '0'.repeat(32)

export const azaharTitleDir = (dir: string, titleId: string): string | null => {
  const hi = titleId.slice(0, 8).toLowerCase(), low = titleId.slice(8).toLowerCase()
  return /^[0-9a-f]{16}$/i.test(titleId) ? join(dir, 'user', 'sdmc', 'Nintendo 3DS', ZERO_ID, ZERO_ID, 'title', hi, low) : null
}

/** Tickets (`<TITLE ID>.<TICKET ID>.tik`, identifiant en majuscules) que l'installation du .cia a écrits pour ce titre. */
export async function azaharTickets(dir: string, titleId: string): Promise<string[]> {
  const ticketDir = join(dir, 'user', 'nand', 'dbs', 'ticket.db')
  const prefix = `${titleId.toUpperCase()}.`
  return (await readdir(ticketDir).catch(() => [] as string[])).filter((n) => n.toUpperCase().startsWith(prefix) && n.toLowerCase().endsWith('.tik')).map((n) => join(ticketDir, n))
}

/** Dossiers que l'installation d'un .cia écrit pour ce titre : son dossier (SD virtuelle) et les tickets (NAND virtuel). Chacun est un conteneur : ce qui compte est ce qui y est créé. */
const azaharRoots = (dir: string, titleId: string): string[] => {
  const t = azaharTitleDir(dir, titleId)
  return t ? [t, join(dir, 'user', 'nand', 'dbs', 'ticket.db')] : []
}

/** Fichiers `.tmd` et `.app` du dossier `content/` d'un titre installé (récursif : les `.app` d'un DLC sont dans `content/00000000/`). */
async function contentFiles(titleDir: string): Promise<{ tmd: number; app: number }> {
  const out = { tmd: 0, app: 0 }
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(d, e.name))
      else if (/\.tmd$/i.test(e.name)) out.tmd++
      else if (/\.app$/i.test(e.name)) out.app++
    }
  }
  await walk(join(titleDir, 'content'))
  return out
}

/** Marge de temps entre la création d'un dossier par l'installation de Kartouche et le moment où Kartouche l'a marquée terminée : une installation d'un .cia dure quelques secondes. */
const PROVENANCE_BEFORE_MS = 15 * 60_000
const PROVENANCE_AFTER_MS = 2 * 60_000

/**
 * Ce contenu a-t-il été CRÉÉ par l'installation de Kartouche ? Pour un contenu installé avant le suivi des fichiers, la seule preuve disponible est la date de création du
 * dossier : s'il a été créé pendant l'installation que Kartouche a enregistrée, c'est elle qui l'a créé. Un dossier plus ancien (installé à la main, ou par un autre outil) n'est jamais retiré.
 */
async function createdByKartouche(path: string, installedAt: number | null | undefined): Promise<boolean> {
  if (!installedAt) return false
  const st = await stat(path).catch(() => null)
  return !!st && st.birthtimeMs >= installedAt - PROVENANCE_BEFORE_MS && st.birthtimeMs <= installedAt + PROVENANCE_AFTER_MS
}

/** `run` : lance `azahar -i` et renvoie vrai si Azahar a installé le .cia (remplaçable dans les tests). */
export function makeAzaharInstaller(run: (exe: string, dir: string, cia: string) => Promise<boolean> = installCia): ContentInstaller {
  return {
  emulatorId: 'azahar',
  managed: false,
  async install(env, item, _game, when) {
    if (!env.emulator) return { state: 'pending', reason: 'emulatorMissing' }
    if (!existsSync(item.path)) return { state: 'failed', reason: 'error', detail: 'fichier absent' }
    if (when === 'import') return { state: 'pending', reason: 'onLaunch' }
    const roots = item.titleId ? azaharRoots(env.emulator.dir, item.titleId) : []
    const before = await snapshotTrees(roots)
    if (!(await run(env.emulator.exe, env.emulator.dir, item.path))) return { state: 'failed', reason: 'error', detail: 'installation refusée par Azahar (voir son journal)' }
    // Vérification indépendante du journal : le dossier du titre doit contenir un TMD et au moins un .app, sinon l'installation est partielle et n'est PAS annoncée terminée.
    if (roots.length) {
      const c = await contentFiles(roots[0])
      if (c.tmd === 0 || c.app === 0) return { state: 'failed', reason: 'error', detail: "installation incomplète (aucun TMD ou aucun .app dans le dossier du titre)" }
    }
    const diff = roots.length ? await diffTrees(before, roots) : { created: [], modified: [] }
    return {
      state: 'installed',
      // Seulement ce que l'installation a créé ; si le titre était déjà là (installé à la main), rien n'appartient à Kartouche.
      emuFiles: await expandCreatedRoots(diff.created, roots),
      detail: diff.modified.length ? `déjà présent dans Azahar : ${diff.modified.length} fichier(s) réécrits, non retirés à la désinstallation` : undefined
    }
  },
  async uninstall(env, items) {
    if (!env.emulator) return { ok: true }
    // Azahar tient ses fichiers ouverts : retirer un titre sous ses pieds le corromprait.
    if (await env.isRunning('azahar.exe')) return { ok: false, detail: 'Azahar est ouvert : le fermer avant de désinstaller' }
    const userDir = resolve(env.emulator.dir, 'user').toLowerCase()
    const inUser = (p: string): boolean => resolve(p).toLowerCase().startsWith(userDir + sep)
    const removed: string[] = []
    let leftover = false
    const drop = async (p: string): Promise<void> => {
      if (!inUser(p)) return // jamais en dehors du dossier utilisateur d'Azahar, même avec un chemin enregistré piégé
      await rm(p, { recursive: true, force: true })
      removed.push(p)
    }
    for (const it of items) {
      const title = it.titleId ? azaharTitleDir(env.emulator.dir, it.titleId) : null
      if (!title || !it.titleId) continue
      if (it.emuFiles) {
        // Suivi exact : seulement ce que l'installation a créé. `[]` = le titre était déjà là avant Kartouche (ou rien n'a été créé) : il n'est pas à lui.
        if (it.emuFiles.length === 0) { leftover = true; continue }
        for (const p of it.emuFiles) await drop(p)
      } else {
        // Installé avant le suivi : retiré seulement si le dossier `content/` a été créé pendant l'installation que Kartouche a enregistrée (UninstallProgram d'Azahar : supprimer `content/`).
        if (!(await createdByKartouche(join(title, 'content'), it.installedAt))) { leftover = true; continue }
        await drop(join(title, 'content'))
        for (const t of await azaharTickets(env.emulator.dir, it.titleId)) if (await createdByKartouche(t, it.installedAt)) await drop(t)
      }
      // Le dossier du titre ne disparaît que s'il est vide : une sauvegarde (`data/`) dedans reste intacte.
      await rmdir(title).catch(() => undefined)
      await rmdir(dirname(title)).catch(() => undefined) // dossier « <id haut> » seulement s'il est devenu vide (rmdir refuse un dossier non vide)
    }
    return { ok: true, leftover: leftover ? 'Azahar' : undefined, removed }
  }
}
}

export const azaharInstaller: ContentInstaller = makeAzaharInstaller()
