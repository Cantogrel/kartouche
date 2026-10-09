import type { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { buildArgs, emulatorById, emulatorForConsole, type EmulatorDef, type GameSession, type LaunchResult, type QuickExit } from '@shared/emulators'
import { resolveLanguage } from '@shared/settings'
import { getRow } from './emulatorStore'
import { connectedNintendoPids, lastUsedPad, preferActive, rankAmong, startPadTracker } from './padChoice'
import { chooseDolphinPads } from './dolphinChoice'
import { chooseMainNintendo, chooseSupportedMain, chooseSupportedPlayers, type SupportedPlayer } from './mainPad'
import { startCemuKeyboardMouse } from './cemuKeyboard'
import { ensureModernSdl2 } from './sdlUpdate'
import { ANY_SDL, applyPsPlayers, type PsPlayer } from './psPads'
import { assignSdlNumbers, listSdlPads } from './sdlOrder'
import { assignSdl2Indexes, listSdl2Joysticks } from './sdl2Order'
import type { EdenNintendo } from './edenPads'
import { chooseEdenPads, edenRefusalReason, shouldCloseOnRefusal, type EdenPlayerPad } from './edenChoice'
import { anyGamepadConnected, autoConfirmEdenApplet, closeGracefully, connectedXInputPads, connectedXInputSlots, watchQuitChord } from './quit'
import { emulatorEnv } from './sdlEnv'
import { applyCemuControls, applyCemuPad, applyCemuPlayers, needsGamePad, type CemuPlayerPad } from './cemu'
import { isVWiiWrapper, readWuaFiles } from '../library/content/wua'
import { applyDolphinFastDiscExclusion, applyDolphinPads, applyAzaharGameConfig, applyAzaharPad, applyDuckstationGame, applyPcsx2Game, applyPpssppGame, applyRpcs3Game, applyRpcs3Pad, applyEdenGameConfig, applyMelondsGame, applyMelondsPad, applyPpssppPads, migrateHybridLayout, applyPsPads, applyEdenPads, azaharCfgPath, ensureDuckstationLogging, setCfgLanguage } from './configure'
import { loadSettings } from '../db/settingsStore'
import { backupSaves, cemuMlcDir, learnCemuKey, prepareRetroarch, readDiscId, snapshotCemuSaves } from '../saves/saves'
import { identifyGame } from '../saves/identify'
import { pcsx2SerialFromLog, preparePcsx2Cards } from './pcsx2Cards'
import { extractZipEntries, readZip } from '../library/hash'
import { ndsGameCode } from './melonds'
import { ncsdTitleId } from './azahar'
import { readPs1Serial } from './duckstation'
import { readPspDiscId } from './ppsspp'
import { readPs2Game } from './pcsx2'
import { detectSonyPad, readPs3Serial } from './rpcs3'
import { installCia } from './content/azahar'
import { installPendingContent } from './content'
import { recordPlaySession } from '../library/stats'
import { chooseEmulator } from '@shared/emulatorChoice'
import { buildCustomCommand, splitArgs, type CustomEmulator } from '@shared/customEmulators'
import { parseLaunchSpec } from '@shared/launch'
import { listCustomEmulators } from './customStore'
import { runLauncherGame, realUriDeps, type UriLaunchDeps } from './launcherUri'
import { isLaunchUri } from '@shared/connectors'
import { runProcess, type RunSpec } from './genericLaunch'

const running = new Map<number, { pid: number; stopped: boolean; graceMs?: number; /** Jeu lancé par son launcher : ferme aussi ses autres processus. */ closeOthers?: () => void }>()

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
  // settings.xml posé à côté de l'exe (voir cemu.ts) met Cemu en mode portable : son journal est dans son dossier ; sinon, dans le dossier utilisateur Windows.
  cemu: (dir) => (existsSync(join(dir, 'settings.xml')) ? join(dir, 'log.txt') : join(homedir(), 'AppData', 'Roaming', 'Cemu', 'log.txt')),
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
  // Déjà extrait par un lancement précédent : on le réutilise (3 Go de plus à écrire à chaque lancement, c'était 9 s d'attente pour Super Mario Galaxy). Il doit avoir la taille exacte de
  // l'entrée et ne pas être plus ancien que l'archive (archive remplacée) ; une extraction interrompue laisse un fichier trop court, donc refait.
  const [have, zipStat] = await Promise.all([stat(dest).catch(() => null), stat(path).catch(() => null)])
  if (have && zipStat && have.size === entries[0].size && have.mtimeMs >= zipStat.mtimeMs) return dest
  await mkdir(dirname(dest), { recursive: true })
  return (await extractZipEntries(path, [{ entry: entries[0].name, dest }]).catch(() => false)) ? dest : null
}

const VITA_INSTALL_TIMEOUT_MS = 300_000

/**
 * Un .vpk doit être installé (décrypté dans le ux0 virtuel) avant de pouvoir être lancé — mais contrairement à un .cia
 * Azahar (le relancer tel quel reboote le titre déjà installé), Vita3K n'auto-boote JAMAIS après un install par chemin
 * de contenu, constaté en vrai même boîtes de confirmation désactivées (« Content installed, will auto-boot: X » dans
 * son propre journal, puis rien — il faut relancer par -r <Title ID>, qui lui boote vraiment). Vita3K journalise sur
 * sa sortie standard (pas de fichier comme Azahar) : on la lit directement.
 */
async function installVpk(exe: string, dir: string, vpkPath: string): Promise<{ titleId: string } | { error: string }> {
  return new Promise((resolve) => {
    let buf = ''
    let done = false
    const child = spawn(exe, [vpkPath], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const finish = (result: { titleId: string } | { error: string }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
      resolve(result)
    }
    const onOutput = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      const ok = /Content installed, will auto-boot: (\S+)/.exec(buf)
      if (ok) { finish({ titleId: ok[1] }); return }
      if (/vitamin dump|aborting installation|miniz error/i.test(buf)) finish({ error: relevantLogLines(buf) })
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.on('error', (e) => finish({ error: e.message }))
    const timer = setTimeout(() => finish({ error: relevantLogLines(buf) || 'timeout' }), VITA_INSTALL_TIMEOUT_MS)
  })
}

interface RunAttempt { elapsedMs: number; stopped: boolean; captured: string }

/**
 * Un jeu Dolphin qui se ferme tout seul très vite (voir QUICK_EXIT_MS) peut être bloqué par `FastDiscSpeed`, activé
 * globalement à l'installation (voir configureDolphin) — sans qu'on sache d'avance lequel : la base officielle des
 * réglages par jeu de Dolphin ne liste actuellement aucun cas de ce genre (vérifié sur GitHub), donc Kartouche n'a pas
 * de liste fiable à embarquer (voir DOLPHIN_FAST_DISC_EXCLUSIONS dans configure.ts). On le désactive pour CE jeu et on
 * retente une seule fois avant de conclure à un vrai échec (BIOS, fichier corrompu…) : si ça règle le problème, le
 * fichier GameSettings créé reste en place pour tous les lancements suivants ; sinon, s'il n'existait pas avant notre
 * tentative, on le supprime pour ne rien laisser d'inutile, et on garde le diagnostic du premier essai (plus parlant,
 * puisque le second n'a rien changé).
 */
async function retryDolphinWithoutFastDiscSpeed(entryId: number, row: { exe: string; dir: string }, args: string[], cacheDir: string, romPath: string, first: RunAttempt): Promise<RunAttempt> {
  const gameId = await readDiscId(romPath).catch(() => null)
  if (!gameId) return first
  const overrideFile = join(row.dir, 'User', 'GameSettings', `${gameId}.ini`)
  const existedBefore = existsSync(overrideFile)
  if (existedBefore && /^\s*FastDiscSpeed\s*=\s*false\s*$/im.test(await readFile(overrideFile, 'utf8').catch(() => ''))) return first
  await applyDolphinFastDiscExclusion(row.dir, gameId, true).catch(() => {})
  const retryStarted = Date.now()
  const child = spawn(row.exe, args, { cwd: dirname(row.exe), stdio: ['ignore', 'pipe', 'pipe'] })
  running.set(entryId, { pid: child.pid ?? 0, stopped: false })
  let captured = ''
  const onOutput = (chunk: Buffer): void => { captured = (captured + chunk.toString('utf8')).slice(-CAPTURE_MAX) }
  child.stdout?.on('data', onOutput)
  child.stderr?.on('data', onOutput)
  // Réarmé pour cette tentative : si elle règle le problème et devient la vraie session de jeu, l'utilisateur doit
  // pouvoir la fermer à la manette comme n'importe quel autre lancement (le raccourci de la 1re tentative s'est
  // déjà arrêté avec elle).
  const watch: { stop: (() => void) | null } = { stop: null }
  let over = false
  void watchQuitChord(cacheDir, () => stopGame(entryId)).then((stop) => { if (over) stop(); else watch.stop = stop }).catch(() => {})
  await new Promise<void>((resolve) => { child.on('error', () => resolve()); child.on('exit', () => resolve()) })
  over = true
  watch.stop?.()
  const retry: RunAttempt = { elapsedMs: Date.now() - retryStarted, stopped: running.get(entryId)?.stopped ?? false, captured }
  const fixed = retry.stopped || retry.elapsedMs >= QUICK_EXIT_MS
  if (!fixed && !existedBefore) await rm(overrideFile, { force: true }).catch(() => {})
  return fixed ? retry : first
}

/** Code de jeu d'une ROM .nds brute (en-tête lu sur 16 octets) ; null pour un autre format. */
async function readNdsCode(path: string): Promise<string | null> {
  if (!/\.nds$/i.test(path)) return null
  const fh = await open(path, 'r')
  try { const b = Buffer.alloc(16); await fh.read(b, 0, 16, 0); return ndsGameCode(b) } finally { await fh.close() }
}

/** Title ID d'une ROM 3DS NCSD (.3ds, .cci) : en-tête lu sur 272 octets ; null pour un autre format (.cia, .cxi…). */
async function readNcsdTitleId(path: string): Promise<string | null> {
  if (!/\.(3ds|cci)$/i.test(path)) return null
  const fh = await open(path, 'r')
  try { const b = Buffer.alloc(0x110); await fh.read(b, 0, b.length, 0); return ncsdTitleId(b) } finally { await fh.close() }
}

/** Surveille les manettes dès l'ouverture de Kartouche : celle utilisée juste avant le lancement d'un jeu est celle que l'émulateur doit lire. */
export const watchPads = startPadTracker

export const isRunning = (entryId: number): boolean => running.has(entryId)

/** Ferme le jeu proprement. */
export function stopGame(entryId: number): void {
  const r = running.get(entryId)
  if (!r) return
  r.stopped = true // pid 0 : jeu lancé par son launcher et pas encore démarré, l'attente s'arrête
  if (r.pid > 0) closeGracefully(r.pid, r.graceMs)
  r.closeOthers?.()
}
export const stopAllGames = (): void => { for (const id of running.keys()) stopGame(id) }
export const runningCount = (): number => running.size

/**
 * Ferme un jeu et attend sa fin réelle (le renderer veut relancer un autre jeu juste après, cf. `otherRunning` dans
 * `launchGame`) : `stopGame` ne fait que signaler la fermeture, le process met un instant à sortir. Abandonne (faux)
 * après `timeoutMs` plutôt que d'attendre indéfiniment un émulateur qui ignore le signal de fermeture.
 */
export async function stopGameAndWait(entryId: number, timeoutMs = 8000): Promise<boolean> {
  if (!running.has(entryId)) return true
  stopGame(entryId)
  const start = Date.now()
  while (running.has(entryId)) {
    if (Date.now() - start > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 150))
  }
  return true
}

/** Vrai si le SDL2 de RetroArch sait réunir une paire de Joy-Con branchée (mis à jour au besoin) ; sans paire branchée, rien n'est téléchargé. */
async function retroPairReady(cacheDir: string, dir: string): Promise<boolean> {
  const pids = connectedNintendoPids()
  if (!(pids.includes(0x2006) && pids.includes(0x2007))) return false
  return ensureModernSdl2(dir, cacheDir).catch(() => false)
}

/** Lance le jeu dans son émulateur, puis cumule le temps de jeu à la fermeture. */
export async function launchGame(db: DatabaseSync, entryId: number, notify: (s: GameSession) => void, cacheDir: string, savesRoot: string, romsDir?: string): Promise<LaunchResult> {
  if (running.has(entryId)) return { ok: false, error: 'running' }
  // Un seul jeu à la fois : deux émulateurs en parallèle se disputent la manette/le focus, et rien n'avertit qu'une
  // partie tourne déjà si on en relance une autre depuis un autre écran. Le renderer propose de fermer l'autre jeu
  // (cf. `stopGameAndWait`) plutôt que de bloquer sans recours.
  if (running.size > 0) return { ok: false, error: 'otherRunning' }
  // Entrée qui n'est pas une ROM (exécutable, jeu de launcher) ou ROM confiée à un émulateur personnalisé : lancement générique, sans la préparation propre aux
  // émulateurs intégrés (configuration, sauvegardes, contenu). Les émulateurs intégrés gardent leur chemin habituel, plus bas.
  const head = db.prepare('SELECT kind, console, path, missing, emulator_id, launch FROM library WHERE id = ?').get(entryId) as
    { kind: string; console: string; path: string; missing: number; emulator_id: string | null; launch: string | null } | undefined
  if (!head) return { ok: false, error: 'noFile' }
  if (head.kind !== 'rom') return launchExternalEntry(db, entryId, head.launch, notify, cacheDir)
  const choice = chooseEmulator({ console: head.console, file: head.path, entryChoice: head.emulator_id, defaults: loadSettings(db).emulatorDefaults, customs: listCustomEmulators(db) })
  if (choice?.kind === 'custom') return launchWithCustomEmulator(db, entryId, head, choice.emulator, notify, cacheDir)
  const entry = db.prepare('SELECT console, title, title_id, path, missing, cia_installed, vita_title_id FROM library WHERE id = ?').get(entryId) as
    { console: string; title: string; title_id: string | null; path: string; missing: number; cia_installed: number; vita_title_id: string | null } | undefined
  if (!entry || entry.missing === 1 || !existsSync(entry.path)) return { ok: false, error: 'noFile' }
  const def = emulatorForConsole(entry.console)
  if (!def) return { ok: false, error: 'noEmulator' }
  const row = getRow(db, def.id)
  if (!row || !existsSync(row.exe)) return { ok: false, error: 'notInstalled', detail: def.id }
  // Vita3K : un .zip (contenu à sa racine) EST la ROM, comme un .vpk — jamais la pré-extraction à fichier unique
  // ci-dessous, faite pour les émulateurs qui n'acceptent qu'une seule ROM par archive (voir importer.ts, même détection).
  const romPath = def.id === 'vita3k' ? entry.path : await resolveZippedRom(entry.path, cacheDir)
  if (!romPath) return { ok: false, error: 'zipUnreadable', detail: entry.path }
  if (def.id === 'azahar' && /\.cia$/i.test(romPath) && !entry.cia_installed) {
    if (!(await installCia(row.exe, row.dir, romPath))) return { ok: false, error: 'ciaInstallFailed', detail: entry.path }
    db.prepare('UPDATE library SET cia_installed = 1 WHERE id = ?').run(entryId)
  }
  // Wii U : un titre Wii (vWii) emballé pour Wii U n'est pas exécutable par Cemu (écran noir) : message clair plutôt qu'un lancement qui ne mène nulle part.
  if (def.id === 'cemu' && /\.wua$/i.test(romPath) && isVWiiWrapper((await readWuaFiles(romPath).catch(() => null)) ?? [])) return { ok: false, error: 'vwiiWrapper', detail: entry.path }
  let vitaTitleId = entry.vita_title_id ?? undefined
  if (def.id === 'vita3k' && !vitaTitleId) {
    const installed = await installVpk(row.exe, row.dir, romPath)
    if ('error' in installed) return { ok: false, error: 'vitaInstallFailed', detail: installed.error }
    vitaTitleId = installed.titleId
    db.prepare('UPDATE library SET vita_title_id = ? WHERE id = ?').run(vitaTitleId, entryId)
  }
  // Mises à jour/DLC rattachés à ce jeu : ce qui n'est pas encore visible de l'émulateur l'est avant le lancement (voir emulators/content/). Un échec n'empêche jamais de jouer.
  if (romsDir) await installPendingContent(db, entryId, romsDir, 'launch').catch(() => undefined)
  const args = buildArgs(def, romPath, entry.console, vitaTitleId)
  if (!args) return { ok: false, error: 'unsupported', detail: def.id }
  // Identifiant du jeu (numéro de série, Title ID…) lu dans le jeu : il rattache ses sauvegardes à lui seul (voir saves.ts) ; mémorisé pour les lancements suivants.
  let gameKey = await identifyGame(db, { id: entryId, console: entry.console, path: entry.path, titleId: entry.title_id, vitaTitleId }, { resolve: async () => romPath, cemuDir: def.id === 'cemu' ? row.dir : undefined }).catch(() => null)
  const cemuBefore = def.id === 'cemu' && !gameKey ? await snapshotCemuSaves(await cemuMlcDir(row.dir)) : null
  // Réservé pendant la préparation (détection de la manette) pour qu'un double clic ne lance pas deux fois le jeu.
  running.set(entryId, { pid: 0, stopped: false })
  try {
    // Dolphin invalide toute liaison qui cite un périphérique absent : la manette branchée est écrite à chaque lancement.
    if (def.id === 'dolphin') {
      const players = await chooseDolphinPads(cacheDir).catch(() => [])
      const gameId = await readDiscId(romPath)
      // Trace du choix (dernière manette utilisée, manettes Nintendo vues) : sert à comprendre un « aucune commande » sans relancer le jeu.
      void mkdir(join(cacheDir, 'tools'), { recursive: true }).then(() => writeFile(join(cacheDir, 'tools', 'dolphin-pad.log'), `${new Date().toISOString()} ${JSON.stringify({ players, nintendo: connectedNintendoPids(), last: lastUsedPad() })}` + String.fromCharCode(10), { flag: 'a' })).catch(() => {})
      await applyDolphinPads(row.dir, players, { console: entry.console, gameId }).catch(() => {})
      // FastDiscSpeed est activé globalement (voir configureDolphin) ; quelques jeux (liste d'exclusion) en ont besoin
      // désactivé pour démarrer correctement — réglage propre à ce jeu, réappliqué à chaque lancement.
      if (gameId) await applyDolphinFastDiscExclusion(row.dir, gameId).catch(() => {})
    }
    // Azahar : profil manette si une manette XInput est branchée, sinon clavier ; réglages propres au jeu seulement si une exception est connue (Title ID).
    if (def.id === 'azahar') {
      // Switch Pro ou paire de Joy-Con en manette principale : profil aux boutons dans l'ordre Nintendo (A/B non croisés, voir configure.ts) ; Joy-Con seul : pas de profil (il manque des boutons).
      const nin = await chooseMainNintendo(cacheDir).catch(() => null)
      await applyAzaharPad(row.dir, await anyGamepadConnected(cacheDir), nin === 'switch-pro' || nin === 'joycon-pair').catch(() => {})
      await applyAzaharGameConfig(row.dir, (await readNcsdTitleId(romPath).catch(() => null)) ?? entry.title_id).catch(() => {})
    }
    // melonDS : disposition d'écrans propre au jeu (code de jeu de la ROM) si une exception est connue, sinon retour à la disposition d'origine.
    // melonDS et RetroArch ne lisent qu'une manette pour le joueur 1 : la dernière sur laquelle on a appuyé (voir padChoice.ts), pas forcément la première branchée.
    const padSlots = def.id === 'melonds' || def.id === 'retroarch' ? await connectedXInputSlots(cacheDir) : []
    const padSlot = preferActive(padSlots, (s) => s)[0] ?? null
    // RetroArch : la Switch Pro passe par son pilote SDL2 (autoconfig fournis). Sa version de SDL2 (2.0.14) ne sait pas réunir les Joy-Con : avec une paire branchée, on la remplace d'abord par la version
    // officielle (voir sdlUpdate.ts) ; si ce n'est pas possible, ou pour un Joy-Con seul, message clair.
    let retroNintendo: { port: number } | null = null
    let cemuNintendo = false
    let retroPlayers: { driver: 'xinput' | 'sdl2'; indexes: number[] } | null = null
    if (def.id === 'retroarch') {
      const retroAccepted: EdenNintendo[] = (await retroPairReady(cacheDir, row.dir)) ? ['switch-pro', 'joycon-pair'] : ['switch-pro']
      const sup = await chooseSupportedMain(cacheDir, retroAccepted).catch(() => ({ pad: null, refused: false }))
      if (sup.refused) { running.delete(entryId); return { ok: false, error: 'padRefusedEmulator' } }
      if (sup.pad && 'nintendo' in sup.pad) retroNintendo = { port: sup.pad.port ?? 0 }
      // Plusieurs joueurs (jusqu'à quatre) : XInput seules = pilote xinput (rang = emplacement) ; avec une manette Nintendo = pilote sdl2, dont on demande les rangs à SDL2 juste avant (voir sdl2Order.ts).
      const rp = await chooseSupportedPlayers(cacheDir, retroAccepted, 4).catch(() => [])
      if (rp.length >= 2) {
        if (rp.every((p) => p.kind === 'xinput')) retroPlayers = { driver: 'xinput', indexes: rp.map((p) => (p.kind === 'xinput' ? p.slot : 0)) }
        else {
          const indexes = assignSdl2Indexes(rp, await listSdl2Joysticks(cacheDir, join(row.dir, 'SDL2.dll'), emulatorEnv('retroarch', true, true)))
          if (indexes.every((i) => i !== null)) retroPlayers = { driver: 'sdl2', indexes: indexes as number[] }
        }
      }
    }
    // PPSSPP lit les manettes par XInput et DirectInput seulement : la Switch Pro y est une manette DirectInput, mais la paire de Joy-Con y est DEUX manettes séparées (message clair plutôt qu'un
    // jeu muet).
    if (def.id === 'ppsspp') {
      const sup = await chooseSupportedMain(cacheDir, ['switch-pro']).catch(() => ({ pad: null, refused: false }))
      if (sup.refused) { running.delete(entryId); return { ok: false, error: 'padRefusedEmulator' } }
    }
    // Azahar (SDL 2.32) : la paire de Joy-Con n'y est réunie en une manette que si on le demande (voir `emulatorEnv`).
    const azaharNintendo = def.id === 'azahar' ? await chooseMainNintendo(cacheDir).catch(() => null) : null
    // melonDS ne lit qu'un joystick SDL (2.32) : la Switch Pro et la paire de Joy-Con réunie en un seul joystick (même disposition de boutons, relevé) ; un Joy-Con seul, non : message clair plutôt qu'un
    // jeu qui ne répond à rien. La manette principale est la première que melonDS sait lire (dernière utilisée en tête).
    let melondsNintendo: { port: number } | null = null
    if (def.id === 'melonds') {
      const sup = await chooseSupportedMain(cacheDir, ['switch-pro', 'joycon-pair']).catch(() => ({ pad: null, refused: false }))
      if (sup.refused) { running.delete(entryId); return { ok: false, error: 'padRefusedEmulator' } }
      if (sup.pad && 'nintendo' in sup.pad) melondsNintendo = { port: sup.pad.port ?? 0 }
    }
    // DuckStation et PCSX2 lisent les manettes SDL par numéro (« SDL-n », l'indice de joueur que SDL leur donne). Un seul joueur : les quatre premières sont liées, quelle que soit celle qu'on utilise.
    // Plusieurs joueurs (deux ports) : chacun lit SA manette, dont on demande le numéro à SDL juste avant (voir sdlOrder.ts) ; sans réponse claire, retour à « n'importe laquelle » pour le joueur 1.
    // Manette Nintendo : sans vibration (gênante), et A/B / X/Y échangés pour la paire de Joy-Con sur DuckStation (voir psPads.ts).
    if (def.id === 'duckstation' || def.id === 'pcsx2') {
      const psFile = def.id === 'duckstation' ? join(row.dir, 'settings.ini') : join(row.dir, 'inis', 'PCSX2.ini')
      const psPlayers = await chooseSupportedPlayers(cacheDir, ['switch-pro', 'joycon-pair', 'joycon-left', 'joycon-right'], 2).catch(() => [])
      const psPlayer = (p: SupportedPlayer, indexes: number[]): PsPlayer => ({ indexes, nintendo: p.kind !== 'xinput', swapFace: def.id === 'duckstation' && p.kind === 'joycon-pair' })
      let psPads: PsPlayer[] = psPlayers.slice(0, 1).map((p) => psPlayer(p, ANY_SDL))
      if (psPlayers.length >= 2) {
        const numbers = assignSdlNumbers(psPlayers, await listSdlPads(cacheDir, join(row.dir, 'SDL3.dll')))
        if (numbers.every((n) => n !== null)) psPads = psPlayers.map((p, i) => psPlayer(p, [numbers[i] as number]))
      }
      await applyPsPlayers(psFile, def.id, psPads).catch(() => {})
    }
    if (def.id === 'melonds') await applyMelondsPad(row.dir, melondsNintendo ? melondsNintendo.port : padSlot === null ? null : rankAmong(padSlots, padSlot), melondsNintendo !== null).catch(() => {})
    if (def.id === 'melonds') await applyMelondsGame(row.dir, await readNdsCode(romPath).catch(() => null)).catch(() => {})
    let edenAssigned: EdenPlayerPad[] = []
    // Eden : une manette par joueur (joueur 1 = la dernière utilisée, les autres dans un ordre stable ; voir edenChoice.ts), sinon clavier ; configuration propre au jeu seulement si une exception est connue (Title ID).
    if (def.id === 'eden') {
      edenAssigned = await chooseEdenPads(cacheDir).catch(() => [])
      await applyEdenPads(row.dir, edenAssigned).catch(() => {})
      await applyEdenGameConfig(row.dir, entry.title_id).catch(() => {})
    }
    // PPSSPP : réglages propres au jeu (DISC_ID lu sur l'ISO) seulement si une exception est connue ; manettes et clavier : défauts natifs de PPSSPP, rien à écrire.
    if (def.id === 'ppsspp') await applyPpssppPads(row.dir).catch(() => {})
    if (def.id === 'melonds' || def.id === 'azahar') await migrateHybridLayout(def.id, row.dir).catch(() => {})
    if (def.id === 'ppsspp') await applyPpssppGame(row.dir, await readPspDiscId(romPath).catch(() => null)).catch(() => {})
    // PCSX2 : réglages propres au jeu (série + CRC de l'exécutable lus sur le disque) seulement si une exception est connue ; les autres jeux n'en reçoivent jamais.
    // Cartes mémoire dédiées au jeu (une par slot) : sans elles, tous les jeux écrivent dans les deux mêmes cartes partagées (voir pcsx2Cards.ts).
    if (def.id === 'pcsx2') {
      const game = await readPs2Game(romPath).catch(() => null)
      await applyPcsx2Game(row.dir, game).catch(() => {})
      const cards = await preparePcsx2Cards(row.dir, game, gameKey, entryId).catch(() => null)
      if (cards?.args.length) args.splice(args.indexOf('--') < 0 ? 0 : args.indexOf('--'), 0, ...cards.args)
    }
    // RPCS3 : sans profil de manette il n'en utilise aucune. Manette XInput (à son emplacement réel), sinon manette Sony native, sinon clavier ; réglages propres au jeu seulement si
    // une exception est connue (numéro de série lu sur le disque).
    if (def.id === 'rpcs3') {
      // Une manette par joueur (joueurs 1 à 7) : XInput, Switch Pro ou paire de Joy-Con, la dernière utilisée en premier ; Joy-Con seul : pas lisible, message clair s'il n'y a rien d'autre. Manette Sony native
      // seulement quand il n'y en a pas d'autre.
      const rpcs3Players = await chooseSupportedPlayers(cacheDir, ['switch-pro', 'joycon-pair'], 7).catch(() => [])
      const rpcs3Pad = (p: SupportedPlayer): { kind: 'xinput' | 'switch-pro' | 'joycon-pair'; slot: number } => (p.kind === 'xinput' ? { kind: 'xinput', slot: p.slot } : { kind: p.kind === 'joycon-pair' ? 'joycon-pair' : 'switch-pro', slot: p.port })
      const sup = await chooseSupportedMain(cacheDir, ['switch-pro', 'joycon-pair']).catch(() => ({ pad: null, refused: false }))
      const pad = rpcs3Players[0] ? rpcs3Pad(rpcs3Players[0]) : await detectSonyPad().then((kind) => (kind ? { kind } : null)).catch(() => null)
      if (!pad && sup.refused) { running.delete(entryId); return { ok: false, error: 'padRefusedEmulator' } }
      await applyRpcs3Pad(row.dir, pad, rpcs3Players.slice(1).map(rpcs3Pad)).catch(() => {})
      await applyRpcs3Game(row.dir, await readPs3Serial(romPath).catch(() => null)).catch(() => {})
    }
    // Cemu : Pro Controller par défaut, profil GamePad pour les jeux qui l'exigent (profil de l'utilisateur jamais touché).
    if (def.id === 'cemu') {
      // Switch Pro et paire de Joy-Con : leurs blocs SDLController sont dans le profil de Kartouche, à côté du clavier et de la XInput (la manette qui répond, répond) ; Joy-Con seul : refusé s'il n'y a rien d'autre.
      const sup = await chooseSupportedMain(cacheDir, ['switch-pro', 'joycon-pair']).catch(() => ({ pad: null, refused: false }))
      cemuNintendo = sup.pad !== null && 'nintendo' in sup.pad
      if (sup.refused) { running.delete(entryId); return { ok: false, error: 'padRefusedEmulator' } }
      await applyCemuControls(row.dir, entry.title, basename(entry.path)).catch(() => {})
      // Une manette par joueur (jusqu'à huit) : XInput, Switch Pro, paire de Joy-Con, la dernière utilisée au joueur 1.
      const cemuPlayers = (await chooseSupportedPlayers(cacheDir, ['switch-pro', 'joycon-pair'], 8).catch(() => [])).flatMap((p): CemuPlayerPad[] => (p.kind === 'xinput' ? [{ kind: 'xinput', slot: p.slot }] : p.kind === 'switch-pro' || p.kind === 'joycon-pair' ? [{ kind: p.kind, port: p.port }] : []))
      await applyCemuPlayers(row.dir, cemuPlayers, needsGamePad(entry.title, basename(entry.path)) ? 'gamepad' : 'pro').catch(() => {})
      await applyCemuPad(row.dir, preferActive(await connectedXInputSlots(cacheDir), (s) => s)[0] ?? 0).catch(() => {})
    }
    // RetroArch range ses sauvegardes et états dans le dossier de données de Kartouche (par jeu, hors de l'installation).
    if (def.id === 'retroarch') await prepareRetroarch(row.dir, savesRoot, padSlot, retroNintendo, retroPlayers).catch(() => {})
    // DuckStation n'écrit rien sur la sortie standard : sans ça, un jeu qui se ferme tout seul ne laisse aucune trace exploitable.
    if (def.id === 'duckstation') {
      await ensureDuckstationLogging(row.dir).catch(() => {})
      // Réglages propres au jeu (numéro de série lu sur le disque) seulement si une exception est connue ; les autres jeux n'en reçoivent jamais.
      await applyDuckstationGame(row.dir, await readPs1Serial(romPath).catch(() => null)).catch(() => {})
    }
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
    const child = spawn(row.exe, args, { cwd: dirname(row.exe), stdio: ['ignore', 'pipe', 'pipe'], env: emulatorEnv(def.id, melondsNintendo !== null || retroNintendo !== null || retroPlayers?.driver === 'sdl2' || azaharNintendo === 'switch-pro' || azaharNintendo === 'joycon-pair' || cemuNintendo, retroPlayers?.driver === 'sdl2') })
    // Vita3K : fermer la fenêtre du jeu ne fait que revenir à sa bibliothèque, le process ne sort jamais seul ; on le force après 2 s au lieu de 5.
    running.set(entryId, { pid: child.pid ?? 0, stopped: false, graceMs: def.id === 'vita3k' ? 2000 : undefined })
    // Capturé au cas où l'émulateur écrit sur la sortie standard (RetroArch, par ex.) ; sert de diagnostic si le jeu se ferme vite.
    let captured = ''
    const onOutput = (chunk: Buffer): void => { captured = (captured + chunk.toString('utf8')).slice(-CAPTURE_MAX) }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    // Retour + Start maintenus sur une manette XInput ferment le jeu proprement (la plupart des émulateurs n'ont pas de « quitter » à la manette).
    let stopWatch: (() => void) | null = null
    let over = false
    void watchQuitChord(cacheDir, () => stopGame(entryId)).then((stop) => { if (over) stop(); else stopWatch = stop }).catch(() => {})
    // Eden : l'applet Contrôleur (jeux à plusieurs joueurs…) est validée à la place de l'utilisateur, les manettes étant déjà assignées (voir quit.ts).
    let stopApplet: (() => void) | null = null
    // Cemu : le clavier à l'écran (nom d'un profil…) n'a pas de navigation à la manette ; pendant qu'il est affiché, le stick droit fait la souris et A le clic (voir cemuKeyboard.ts).
    let stopKeyboard: (() => void) | null = null
    if (def.id === 'cemu' && child.pid) void startCemuKeyboardMouse(cacheDir, child.pid).then((stop) => { if (over) stop(); else stopKeyboard = stop }).catch(() => {})
    // Le jeu refuse les manettes assignées (applet bloquée) : on le ferme et on explique ce qu'il faut brancher (play.padRefused*), au lieu de laisser l'utilisateur devant une fenêtre sans issue.
    let padRefusal: 'padRefusedJoycon' | 'padRefusedCount' | null = null
    if (def.id === 'eden') {
      void autoConfirmEdenApplet(cacheDir, () => { if (!padRefusal && shouldCloseOnRefusal(Date.now() - started)) { padRefusal = edenRefusalReason(edenAssigned); stopGame(entryId) } })
        .then((stop) => { if (over) stop(); else stopApplet = stop }).catch(() => {})
    }
    const finish = async (): Promise<void> => {
      if (over) return
      over = true
      stopWatch?.()
      stopApplet?.()
      stopKeyboard?.()
      let attempt: RunAttempt = { elapsedMs: Date.now() - started, stopped: running.get(entryId)?.stopped ?? false, captured }
      if (def.id === 'dolphin' && !attempt.stopped && attempt.elapsedMs < QUICK_EXIT_MS) {
        attempt = await retryDolphinWithoutFastDiscSpeed(entryId, row, args, cacheDir, romPath, attempt).catch(() => attempt)
      }
      running.delete(entryId)
      const minutes = sessionMinutes(attempt.elapsedMs)
      db.prepare('UPDATE library SET play_minutes = play_minutes + ?, last_played = ? WHERE id = ?').run(minutes, Date.now(), entryId)
      if (minutes > 0) recordPlaySession(db, entryId, started, Date.now(), minutes) // une partie de moins de 30 s (échec de lancement) n'est pas une session
      const total = db.prepare('SELECT play_minutes FROM library WHERE id = ?').get(entryId) as { play_minutes: number } | undefined
      // Fermé tout seul (pas par l'utilisateur) en moins de QUICK_EXIT_MS : probablement un échec plutôt qu'une vraie partie.
      let quickExit: QuickExit | undefined
      if (padRefusal) quickExit = { elapsedMs: attempt.elapsedMs, immediate: padRefusal }
      else if (!attempt.stopped && attempt.elapsedMs < QUICK_EXIT_MS) {
        quickExit = { elapsedMs: attempt.elapsedMs, log: attempt.captured.trim() || (await readLaunchLog(def, row.dir)) }
      }
      notify({ entryId, running: false, playMinutes: total?.play_minutes, quickExit })
      // Identifiant appris de l'émulateur quand le jeu ne permet pas de le lire : Cemu (Title ID, d'après le dossier de sauvegarde créé pendant la partie), PCSX2 (journal).
      if (!gameKey && def.id === 'cemu' && cemuBefore) gameKey = await learnCemuKey(db, entryId, await cemuMlcDir(row.dir), cemuBefore).catch(() => null)
      if (!gameKey && def.id === 'pcsx2') {
        gameKey = await pcsx2SerialFromLog(row.dir).catch(() => null)
        if (gameKey) db.prepare('UPDATE library SET game_key = ? WHERE id = ?').run(gameKey, entryId)
      }
      // Copie de sécurité des sauvegardes de ce jeu, seulement si elles ont changé depuis la dernière.
      if (loadSettings(db).autoBackupSaves) void backupSaves(db, savesRoot, { id: entryId, console: entry.console, path: entry.path, gameKey }, true).catch(() => {})
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

/** Jeu confié à un émulateur personnalisé : la ligne de commande vient du modèle d'arguments de l'utilisateur, rien n'est configuré chez l'émulateur. */
async function launchWithCustomEmulator(db: DatabaseSync, entryId: number, head: { console: string; path: string; missing: number }, emu: CustomEmulator, notify: (s: GameSession) => void, cacheDir: string): Promise<LaunchResult> {
  if (head.missing === 1 || !existsSync(head.path)) return { ok: false, error: 'noFile' }
  if (!existsSync(emu.exe)) return { ok: false, error: 'notInstalled', detail: emu.name }
  const cmd = buildCustomCommand(emu, { rom: head.path, console: head.console })
  return superviseProcess(db, entryId, { exe: cmd.exe, args: cmd.args, cwd: dirname(cmd.exe) }, notify, cacheDir)
}

/** Exécutable ajouté à la main ou jeu de launcher : lancé tel quel. (Les jeux lancés par l'adresse d'un launcher viennent avec leurs connecteurs.) */
async function launchExternalEntry(db: DatabaseSync, entryId: number, launchJson: string | null, notify: (s: GameSession) => void, cacheDir: string, uriDeps: UriLaunchDeps = realUriDeps): Promise<LaunchResult> {
  const spec = parseLaunchSpec(launchJson)
  if (!spec) return { ok: false, error: 'unsupported' }
  const direct = (): Promise<LaunchResult> | null => spec.exe && existsSync(spec.exe)
    ? superviseProcess(db, entryId, { exe: spec.exe, args: splitArgs(spec.args ?? ''), cwd: spec.cwd ?? dirname(spec.exe) }, notify, cacheDir)
    : null
  if (spec.type === 'exe') return direct() ?? { ok: false, error: spec.exe ? 'noFile' : 'unsupported' }

  // Jeu d'un launcher : l'adresse du launcher le démarre (Steam, Epic…) ; l'exécutable, s'il est connu, sert de repli quand le launcher est absent ou ne démarre rien.
  if (!spec.uri || !isLaunchUri(spec.uri)) return direct() ?? { ok: false, error: 'unsupported' }
  const dir = spec.installDir ?? (spec.exe ? dirname(spec.exe) : null)
  if (!dir) { uriDeps.open(spec.uri); return { ok: true } } // rien pour suivre la partie : le launcher la lance, sans temps de jeu
  const uri = spec.uri
  running.set(entryId, { pid: 0, stopped: false })
  notify({ entryId, running: true })
  let stopWatch: (() => void) | null = null
  let over = false
  void watchQuitChord(cacheDir, () => stopGame(entryId)).then((stop) => { if (over) stop(); else stopWatch = stop }).catch(() => {})
  void runLauncherGame({
    uri, dir, deps: uriDeps, cancelled: () => running.get(entryId)?.stopped === true,
    onStart: (pids, startedAt) => {
      const prev = running.get(entryId)
      running.set(entryId, { pid: pids()[0] ?? 0, stopped: prev?.stopped ?? false, closeOthers: () => { for (const p of pids().slice(1)) closeGracefully(p) } })
      void startedAt
    }
  }).then(async (outcome) => {
    over = true
    stopWatch?.()
    const stopped = running.get(entryId)?.stopped ?? false
    running.delete(entryId)
    if (outcome.status === 'ended') {
      const minutes = sessionMinutes(outcome.endedAt - outcome.startedAt)
      db.prepare('UPDATE library SET play_minutes = play_minutes + ?, last_played = ? WHERE id = ?').run(minutes, Date.now(), entryId)
      if (minutes > 0) recordPlaySession(db, entryId, outcome.startedAt, outcome.endedAt, minutes)
      const total = db.prepare('SELECT play_minutes FROM library WHERE id = ?').get(entryId) as { play_minutes: number } | undefined
      notify({ entryId, running: false, playMinutes: total?.play_minutes })
    } else if (outcome.status === 'cancelled' || stopped) {
      notify({ entryId, running: false })
    } else {
      // Launcher absent (aucune application pour son adresse) ou rien n'a démarré : l'exécutable lance le jeu directement quand il est connu.
      const fallback = direct()
      if (fallback) { const r = await fallback; if (!r.ok) notify({ entryId, running: false, quickExit: { elapsedMs: 0, log: r.detail ?? r.error } }) }
      else notify({ entryId, running: false, quickExit: { elapsedMs: 0, log: outcome.status === 'noProtocol' ? 'Launcher not installed' : 'The launcher did not start the game' } })
    }
  })
  return { ok: true }
}

/**
 * Lance un processus et en suit la session comme pour un émulateur : un seul jeu à la fois, arrêt propre (Ctrl+Alt+Q, Retour+Start, bouton « Fermer le jeu »),
 * temps de jeu et session enregistrés à la fin, fermeture rapide signalée avec la sortie du processus.
 */
async function superviseProcess(db: DatabaseSync, entryId: number, spec: RunSpec, notify: (s: GameSession) => void, cacheDir: string): Promise<LaunchResult> {
  const started = Date.now()
  const handle = runProcess(spec)
  if (handle.pid === 0) return { ok: false, error: 'spawn', detail: (await handle.done).error }
  running.set(entryId, { pid: handle.pid, stopped: false })
  let stopWatch: (() => void) | null = null
  let over = false
  void watchQuitChord(cacheDir, () => stopGame(entryId)).then((stop) => { if (over) stop(); else stopWatch = stop }).catch(() => {})
  void handle.done.then((outcome) => {
    over = true
    stopWatch?.()
    const stopped = running.get(entryId)?.stopped ?? false
    running.delete(entryId)
    const minutes = sessionMinutes(outcome.elapsedMs)
    db.prepare('UPDATE library SET play_minutes = play_minutes + ?, last_played = ? WHERE id = ?').run(minutes, Date.now(), entryId)
    if (minutes > 0) recordPlaySession(db, entryId, started, Date.now(), minutes)
    const total = db.prepare('SELECT play_minutes FROM library WHERE id = ?').get(entryId) as { play_minutes: number } | undefined
    // Fermeture rapide = échec probable, sauf sortie propre (code 0) : un raccourci ou un lanceur qui passe la main à une autre application (Bloc-notes du Store…) rend la main tout de suite.
    const quickExit: QuickExit | undefined = !stopped && outcome.elapsedMs < QUICK_EXIT_MS && outcome.exitCode !== 0 ? { elapsedMs: outcome.elapsedMs, log: (outcome.error ?? outcome.captured.trim()) || undefined } : undefined
    notify({ entryId, running: false, playMinutes: total?.play_minutes, quickExit })
  })
  notify({ entryId, running: true })
  return { ok: true }
}

/** Ouvre l'émulateur seul (configuration, installation du firmware). */
export function openEmulator(db: DatabaseSync, id: string): LaunchResult {
  const def = emulatorById(id)
  const row = def && getRow(db, id)
  if (!def || !row || !existsSync(row.exe)) return { ok: false, error: 'notInstalled', detail: id }
  try {
    spawn(row.exe, [], { cwd: dirname(row.exe), stdio: 'ignore', detached: true, env: emulatorEnv(row.id) }).unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: 'spawn', detail: e instanceof Error ? e.message : String(e) }
  }
}
