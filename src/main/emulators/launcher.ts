import type { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { buildArgs, emulatorById, emulatorForConsole, type EmulatorDef, type GameSession, type LaunchResult, type QuickExit } from '@shared/emulators'
import { resolveLanguage } from '@shared/settings'
import { getRow } from './emulatorStore'
import { anyGamepadConnected, closeGracefully, connectedXInputPads, connectedXInputSlots, watchQuitChord } from './quit'
import { emulatorEnv } from './sdlEnv'
import { applyCemuControls } from './cemu'
import { isVWiiWrapper, readWuaFiles } from '../library/content/wua'
import { applyDolphinFastDiscExclusion, applyDolphinPad, applyAzaharGameConfig, applyAzaharPad, applyDuckstationGame, applyPcsx2Game, applyPpssppGame, applyRpcs3Game, applyRpcs3Pad, applyEdenGameConfig, applyMelondsGame, applyEdenPad, azaharCfgPath, ensureDuckstationLogging, setCfgLanguage } from './configure'
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

const running = new Map<number, { pid: number; stopped: boolean; graceMs?: number }>()

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

export const isRunning = (entryId: number): boolean => running.has(entryId)

/** Ferme le jeu proprement. */
export function stopGame(entryId: number): void {
  const r = running.get(entryId)
  if (r && r.pid > 0) { r.stopped = true; closeGracefully(r.pid, r.graceMs) }
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

/** Lance le jeu dans son émulateur, puis cumule le temps de jeu à la fermeture. */
export async function launchGame(db: DatabaseSync, entryId: number, notify: (s: GameSession) => void, cacheDir: string, savesRoot: string, romsDir?: string): Promise<LaunchResult> {
  if (running.has(entryId)) return { ok: false, error: 'running' }
  // Un seul jeu à la fois : deux émulateurs en parallèle se disputent la manette/le focus, et rien n'avertit qu'une
  // partie tourne déjà si on en relance une autre depuis un autre écran. Le renderer propose de fermer l'autre jeu
  // (cf. `stopGameAndWait`) plutôt que de bloquer sans recours.
  if (running.size > 0) return { ok: false, error: 'otherRunning' }
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
      const slots = await connectedXInputSlots(cacheDir)
      const gameId = await readDiscId(romPath)
      await applyDolphinPad(row.dir, slots.length ? slots[0] : null, { console: entry.console, gameId }).catch(() => {})
      // FastDiscSpeed est activé globalement (voir configureDolphin) ; quelques jeux (liste d'exclusion) en ont besoin
      // désactivé pour démarrer correctement — réglage propre à ce jeu, réappliqué à chaque lancement.
      if (gameId) await applyDolphinFastDiscExclusion(row.dir, gameId).catch(() => {})
    }
    // Azahar : profil manette si une manette XInput est branchée, sinon clavier ; réglages propres au jeu seulement si une exception est connue (Title ID).
    if (def.id === 'azahar') {
      await applyAzaharPad(row.dir, await anyGamepadConnected(cacheDir)).catch(() => {})
      await applyAzaharGameConfig(row.dir, (await readNcsdTitleId(romPath).catch(() => null)) ?? entry.title_id).catch(() => {})
    }
    // melonDS : disposition d'écrans propre au jeu (code de jeu de la ROM) si une exception est connue, sinon retour à la disposition d'origine.
    if (def.id === 'melonds') await applyMelondsGame(row.dir, await readNdsCode(romPath).catch(() => null)).catch(() => {})
    // Eden : manette XInput si branchée, sinon clavier ; configuration propre au jeu seulement si une exception est connue (Title ID).
    if (def.id === 'eden') {
      await applyEdenPad(row.dir, (await connectedXInputPads(cacheDir))[0] ?? null).catch(() => {})
      await applyEdenGameConfig(row.dir, entry.title_id).catch(() => {})
    }
    // PPSSPP : réglages propres au jeu (DISC_ID lu sur l'ISO) seulement si une exception est connue ; manettes et clavier : défauts natifs de PPSSPP, rien à écrire.
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
      const slots = await connectedXInputSlots(cacheDir)
      const pad = slots.length ? { kind: 'xinput' as const, slot: slots[0] } : await detectSonyPad().then((kind) => (kind ? { kind } : null)).catch(() => null)
      await applyRpcs3Pad(row.dir, pad).catch(() => {})
      await applyRpcs3Game(row.dir, await readPs3Serial(romPath).catch(() => null)).catch(() => {})
    }
    // Cemu : Pro Controller par défaut, profil GamePad pour les jeux qui l'exigent (profil de l'utilisateur jamais touché).
    if (def.id === 'cemu') await applyCemuControls(row.dir, entry.title, basename(entry.path)).catch(() => {})
    // RetroArch range ses sauvegardes et états dans le dossier de données de Kartouche (par jeu, hors de l'installation).
    if (def.id === 'retroarch') await prepareRetroarch(row.dir, savesRoot).catch(() => {})
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
    const child = spawn(row.exe, args, { cwd: dirname(row.exe), stdio: ['ignore', 'pipe', 'pipe'], env: emulatorEnv(def.id) })
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
    const finish = async (): Promise<void> => {
      if (over) return
      over = true
      stopWatch?.()
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
      if (!attempt.stopped && attempt.elapsedMs < QUICK_EXIT_MS) {
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
