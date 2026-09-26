import type { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildArgs, emulatorById, emulatorForConsole, type GameSession, type LaunchResult } from '@shared/emulators'
import { getRow } from './emulatorStore'
import { closeGracefully, connectedXInputSlots, watchQuitChord } from './quit'
import { applyDolphinPad } from './configure'
import { loadSettings } from '../db/settingsStore'
import { backupSaves, prepareRetroarch } from '../saves/saves'

const running = new Map<number, { pid: number }>()

/** Temps de jeu arrondi à la minute ; une session de moins de 30 s ne compte pas. */
export const sessionMinutes = (ms: number): number => Math.floor((ms + 30000) / 60000)

export const isRunning = (entryId: number): boolean => running.has(entryId)

/** Ferme le jeu proprement. */
export function stopGame(entryId: number): void {
  const r = running.get(entryId)
  if (r && r.pid > 0) closeGracefully(r.pid)
}
export const stopAllGames = (): void => { for (const id of running.keys()) stopGame(id) }
export const runningCount = (): number => running.size

/** Lance le jeu dans son émulateur, puis cumule le temps de jeu à la fermeture. */
export async function launchGame(db: DatabaseSync, entryId: number, notify: (s: GameSession) => void, cacheDir: string, savesRoot: string): Promise<LaunchResult> {
  if (running.has(entryId)) return { ok: false, error: 'running' }
  const entry = db.prepare('SELECT console, path, missing FROM library WHERE id = ?').get(entryId) as { console: string; path: string; missing: number } | undefined
  if (!entry || entry.missing === 1 || !existsSync(entry.path)) return { ok: false, error: 'noFile' }
  const def = emulatorForConsole(entry.console)
  if (!def) return { ok: false, error: 'noEmulator' }
  const row = getRow(db, def.id)
  if (!row || !existsSync(row.exe)) return { ok: false, error: 'notInstalled', detail: def.id }
  const args = buildArgs(def, entry.path, entry.console)
  if (!args) return { ok: false, error: 'unsupported', detail: def.id }
  // Réservé pendant la préparation (détection de la manette) pour qu'un double clic ne lance pas deux fois le jeu.
  running.set(entryId, { pid: 0 })
  try {
    // Dolphin invalide toute liaison qui cite un périphérique absent : la manette branchée est écrite à chaque lancement.
    if (def.id === 'dolphin') {
      const slots = await connectedXInputSlots(cacheDir)
      await applyDolphinPad(row.dir, slots.length ? slots[0] : null).catch(() => {})
    }
    // RetroArch range ses sauvegardes et états dans le dossier de données de RomVault (par jeu, hors de l'installation).
    if (def.id === 'retroarch') await prepareRetroarch(row.dir, savesRoot).catch(() => {})
    const started = Date.now()
    const child = spawn(row.exe, args, { cwd: dirname(row.exe), stdio: 'ignore' })
    running.set(entryId, { pid: child.pid ?? 0 })
    // Retour + Start maintenus sur une manette XInput ferment le jeu proprement (la plupart des émulateurs n'ont pas de « quitter » à la manette).
    let stopWatch: (() => void) | null = null
    let over = false
    void watchQuitChord(cacheDir, () => stopGame(entryId)).then((stop) => { if (over) stop(); else stopWatch = stop }).catch(() => {})
    const finish = (): void => {
      if (over) return
      over = true
      stopWatch?.()
      running.delete(entryId)
      const minutes = sessionMinutes(Date.now() - started)
      db.prepare('UPDATE library SET play_minutes = play_minutes + ?, last_played = ? WHERE id = ?').run(minutes, Date.now(), entryId)
      const total = db.prepare('SELECT play_minutes FROM library WHERE id = ?').get(entryId) as { play_minutes: number } | undefined
      notify({ entryId, running: false, playMinutes: total?.play_minutes })
      // Copie de sécurité des sauvegardes de ce jeu, seulement si elles ont changé depuis la dernière.
      if (loadSettings(db).autoBackupSaves) void backupSaves(db, savesRoot, { id: entryId, console: entry.console, path: entry.path }, true).catch(() => {})
    }
    child.on('error', finish)
    child.on('exit', finish)
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
