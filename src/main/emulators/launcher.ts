import type { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { buildArgs, emulatorById, emulatorForConsole, type EmulatorDef, type GameSession, type LaunchResult, type QuickExit } from '@shared/emulators'
import { resolveLanguage } from '@shared/settings'
import { getRow } from './emulatorStore'
import { closeGracefully, connectedXInputSlots, watchQuitChord } from './quit'
import { applyDolphinPad, azaharCfgPath, ensureDuckstationLogging, setCfgLanguage } from './configure'
import { loadSettings } from '../db/settingsStore'
import { backupSaves, prepareRetroarch } from '../saves/saves'
import { extractZipEntries, readZip } from '../library/hash'

const running = new Map<number, { pid: number; stopped: boolean }>()

/** En dessous, une fermeture sans intervention de l'utilisateur est probablement un échec (BIOS refusé, fichier manquant…) plutôt qu'une vraie partie. */
const QUICK_EXIT_MS = 10_000
/** Combien de sortie standard/erreur de l'émulateur on garde (les émulateurs à interface graphique n'écrivent en général rien ici). */
const CAPTURE_MAX = 8000

/**
 * Fichier de journal connu par émulateur, pour quand celui-ci n'écrit rien sur la sortie standard (cas de la plupart des
 * interfaces Qt/wx). Limité aux emplacements par défaut bien établis ; les autres émulateurs restent couverts par la seule
 * détection (fermeture rapide signalée) tant que leur propre emplacement de journal n'a pas été vérifié.
 */
const KNOWN_LOG_FILES: Record<string, (dir: string) => string> = {
  duckstation: (dir) => join(dir, 'duckstation.log'),
  rpcs3: (dir) => join(dir, 'log', 'RPCS3.log'),
  // Cemu n'est pas installé en mode portable par RomVault (pas d'entrée `portable` dans EMULATORS) : il journalise dans son dossier utilisateur Windows.
  cemu: () => join(homedir(), 'AppData', 'Roaming', 'Cemu', 'log.txt'),
  azahar: (dir) => join(dir, 'user', 'log', 'azahar_log.txt')
}

/** Ne garde que les lignes qui ressemblent à un avertissement/erreur (format DuckStation « W(fn): » / « E(fn): », ou mot « error »/« warn ») ; sinon les dernières lignes. */
export function relevantLogLines(text: string, max = 20): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const flagged = lines.filter((l) => /^[EW][/(]/.test(l) || /error|warn/i.test(l))
  return (flagged.length ? flagged : lines.slice(-max)).slice(-max).join('\n')
}

async function readLaunchLog(def: EmulatorDef, dir: string): Promise<string | undefined> {
  const known = KNOWN_LOG_FILES[def.id]
  if (!known) return undefined
  try { return relevantLogLines(await readFile(known(dir), 'utf8')) } catch { return undefined }
}

/** Temps de jeu arrondi à la minute ; une session de moins de 30 s ne compte pas. */
export const sessionMinutes = (ms: number): number => Math.floor((ms + 30000) / 60000)

/**
 * Le lecteur de zip intégré à certains émulateurs échoue sur des archives par ailleurs valides (constaté sur des .gbc
 * No-Intro avec RetroArch : drapeau EFS/UTF-8, `version made by` inhabituel — RetroArch tente alors d'ouvrir le .zip
 * lui-même comme ROM et se ferme aussitôt), et d'autres (Azahar…) ne savent tout simplement pas lire un .zip. Dans
 * tous les cas on décompresse nous-mêmes avec notre propre lecteur de zip (celui du hash, déjà plus tolérant) et on
 * donne à l'émulateur un fichier brut, quel qu'il soit. Renvoie `path` tel quel si ce n'est pas un zip ; null si
 * l'archive ne contient pas exactement un fichier ou n'a pas pu être extraite.
 */
export async function resolveZippedRom(path: string, cacheDir: string): Promise<string | null> {
  if (!/\.zip$/i.test(path)) return path
  const entries = await readZip(path).catch(() => null)
  if (!entries || entries.length !== 1) return null
  const dest = join(cacheDir, 'extracted-rom', basename(entries[0].name))
  await mkdir(dirname(dest), { recursive: true })
  return (await extractZipEntries(path, [{ entry: entries[0].name, dest }]).catch(() => false)) ? dest : null
}

const CIA_INSTALL_TIMEOUT_MS = 120_000

/**
 * Un .cia doit être installé une fois dans le « NAND » virtuel d'Azahar avant de pouvoir être lancé (sinon : « il faut
 * d'abord l'installer »). Azahar sait le faire en ligne de commande (`-i`), mais affiche ensuite une boîte de dialogue
 * bloquante que personne ne clique jamais dans ce flux : le résultat est déjà écrit dans le journal d'Azahar avant cet
 * affichage (`Installed … successfully.`, ou une ligne d'erreur), donc on le lit là plutôt que d'attendre un clic qui
 * ne viendra pas, puis on ferme la fenêtre nous-mêmes.
 */
async function installCia(exe: string, dir: string, ciaPath: string): Promise<boolean> {
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

export const isRunning = (entryId: number): boolean => running.has(entryId)

/** Ferme le jeu proprement. */
export function stopGame(entryId: number): void {
  const r = running.get(entryId)
  if (r && r.pid > 0) { r.stopped = true; closeGracefully(r.pid) }
}
export const stopAllGames = (): void => { for (const id of running.keys()) stopGame(id) }
export const runningCount = (): number => running.size

/** Lance le jeu dans son émulateur, puis cumule le temps de jeu à la fermeture. */
export async function launchGame(db: DatabaseSync, entryId: number, notify: (s: GameSession) => void, cacheDir: string, savesRoot: string): Promise<LaunchResult> {
  if (running.has(entryId)) return { ok: false, error: 'running' }
  const entry = db.prepare('SELECT console, path, missing, cia_installed FROM library WHERE id = ?').get(entryId) as
    { console: string; path: string; missing: number; cia_installed: number } | undefined
  if (!entry || entry.missing === 1 || !existsSync(entry.path)) return { ok: false, error: 'noFile' }
  const def = emulatorForConsole(entry.console)
  if (!def) return { ok: false, error: 'noEmulator' }
  const row = getRow(db, def.id)
  if (!row || !existsSync(row.exe)) return { ok: false, error: 'notInstalled', detail: def.id }
  const romPath = await resolveZippedRom(entry.path, cacheDir)
  if (!romPath) return { ok: false, error: 'zipUnreadable', detail: entry.path }
  if (def.id === 'azahar' && /\.cia$/i.test(romPath) && !entry.cia_installed) {
    if (!(await installCia(row.exe, row.dir, romPath))) return { ok: false, error: 'ciaInstallFailed', detail: entry.path }
    db.prepare('UPDATE library SET cia_installed = 1 WHERE id = ?').run(entryId)
  }
  const args = buildArgs(def, romPath, entry.console)
  if (!args) return { ok: false, error: 'unsupported', detail: def.id }
  // Réservé pendant la préparation (détection de la manette) pour qu'un double clic ne lance pas deux fois le jeu.
  running.set(entryId, { pid: 0, stopped: false })
  try {
    // Dolphin invalide toute liaison qui cite un périphérique absent : la manette branchée est écrite à chaque lancement.
    if (def.id === 'dolphin') {
      const slots = await connectedXInputSlots(cacheDir)
      await applyDolphinPad(row.dir, slots.length ? slots[0] : null).catch(() => {})
    }
    // RetroArch range ses sauvegardes et états dans le dossier de données de RomVault (par jeu, hors de l'installation).
    if (def.id === 'retroarch') await prepareRetroarch(row.dir, savesRoot).catch(() => {})
    // DuckStation n'écrit rien sur la sortie standard : sans ça, un jeu qui se ferme tout seul ne laisse aucune trace exploitable.
    if (def.id === 'duckstation') await ensureDuckstationLogging(row.dir).catch(() => {})
    // La langue de la console 3DS vit dans un fichier binaire du NAND émulé créé au premier jeu lancé (jamais à l'installation,
    // voir azaharCfgPath) : on la corrige dès que ce fichier existe, à chaque lancement (le tout premier reste en anglais).
    if (def.id === 'azahar') {
      await (async () => {
        const cfg = azaharCfgPath(row.dir)
        if (!existsSync(cfg)) return
        const data = await readFile(cfg)
        const fr = resolveLanguage(loadSettings(db).language, app.getLocale()) === 'fr'
        if (setCfgLanguage(data, fr ? 2 : 1)) await writeFile(cfg, data)
      })().catch(() => {})
    }
    const started = Date.now()
    const child = spawn(row.exe, args, { cwd: dirname(row.exe), stdio: ['ignore', 'pipe', 'pipe'] })
    running.set(entryId, { pid: child.pid ?? 0, stopped: false })
    // Capturé au cas où l'émulateur écrit sur la sortie standard (RetroArch, par ex.) ; sert de diagnostic si le jeu se ferme vite.
    let captured = ''
    const onOutput = (chunk: Buffer): void => { captured = (captured + chunk.toString('utf8')).slice(-CAPTURE_MAX) }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    // Retour + Start maintenus sur une manette XInput ferment le jeu proprement (la plupart des émulateurs n'ont pas de « quitter » à la manette).
    let stopWatch: (() => void) | null = null
    let over = false
    void watchQuitChord(cacheDir, () => stopGame(entryId)).then((stop) => { if (over) stop(); else stopWatch = stop }).catch(() => {})
    const finish = async (): Promise<void> => {
      if (over) return
      over = true
      stopWatch?.()
      const stopped = running.get(entryId)?.stopped ?? false
      running.delete(entryId)
      const elapsedMs = Date.now() - started
      const minutes = sessionMinutes(elapsedMs)
      db.prepare('UPDATE library SET play_minutes = play_minutes + ?, last_played = ? WHERE id = ?').run(minutes, Date.now(), entryId)
      const total = db.prepare('SELECT play_minutes FROM library WHERE id = ?').get(entryId) as { play_minutes: number } | undefined
      // Fermé tout seul (pas par l'utilisateur) en moins de QUICK_EXIT_MS : probablement un échec plutôt qu'une vraie partie.
      let quickExit: QuickExit | undefined
      if (!stopped && elapsedMs < QUICK_EXIT_MS) {
        quickExit = { elapsedMs, log: captured.trim() || (await readLaunchLog(def, row.dir)) }
      }
      notify({ entryId, running: false, playMinutes: total?.play_minutes, quickExit })
      // Copie de sécurité des sauvegardes de ce jeu, seulement si elles ont changé depuis la dernière.
      if (loadSettings(db).autoBackupSaves) void backupSaves(db, savesRoot, { id: entryId, console: entry.console, path: entry.path }, true).catch(() => {})
    }
    child.on('error', () => void finish())
    child.on('exit', () => void finish())
    notify({ entryId, running: true })
    return { ok: true }
  } catch (e) {
    running.delete(entryId)
    return { ok: false, error: 'spawn', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** Ouvre l'émulateur seul (configuration, installation du firmware). */
export function openEmulator(db: DatabaseSync, id: string): LaunchResult {
  const def = emulatorById(id)
  const row = def && getRow(db, id)
  if (!def || !row || !existsSync(row.exe)) return { ok: false, error: 'notInstalled', detail: id }
  try {
    spawn(row.exe, [], { cwd: dirname(row.exe), stdio: 'ignore', detached: true }).unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: 'spawn', detail: e instanceof Error ? e.message : String(e) }
  }
}
