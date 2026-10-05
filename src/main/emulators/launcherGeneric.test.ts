import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GameSession } from '@shared/emulators'
import { migrate } from '../db/migrations'
import { upsertExternalEntry } from '../library/external'
import { getStats } from '../library/stats'
import { saveCustomEmulator } from './customStore'
import { isRunning, launchGame, stopGame } from './launcher'

// L'application Electron et la surveillance de la manette n'ont rien à faire dans un test : on lance de VRAIS processus (node) mais sans elles.
vi.mock('electron', () => ({ app: { getLocale: () => 'fr', getAppPath: () => '' } }))
vi.mock('./quit', () => ({
  anyGamepadConnected: async () => false,
  closeGracefully: (pid: number) => { try { process.kill(pid) } catch { /* déjà terminé */ } },
  connectedXInputPads: async () => 0,
  connectedXInputSlots: async () => [],
  watchQuitChord: async () => () => undefined
}))

const NODE = process.execPath
let dir: string
let db: DatabaseSync
let sessions: GameSession[]
const notify = (s: GameSession): void => { sessions.push(s) }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'klaunch-')); db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db); sessions = [] })
afterEach(() => { vi.useRealTimers(); db.close(); rmSync(dir, { recursive: true, force: true }) })

const launch = (id: number): ReturnType<typeof launchGame> => launchGame(db, id, notify, join(dir, 'cache'), join(dir, 'saves'))
const ended = async (id: number): Promise<GameSession> => {
  for (let i = 0; i < 400; i++) { const e = sessions.find((s) => s.entryId === id && !s.running); if (e) return e; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('la partie ne s’est pas terminée')
}
/** Entrée « exécutable » : chemin propre à chaque jeu (la même application peut être ajoutée plusieurs fois avec des arguments différents dans ce test). */
const addExe = (title: string, script: string, exe = NODE): number =>
  Number(db.prepare("INSERT INTO library (console, title, path, size, match, added_at, kind, source, launch) VALUES ('pc', ?, ?, 0, 'none', 0, 'exe', 'manual', ?)")
    .run(title, `exe:${title}`, JSON.stringify({ type: 'exe', exe, args: `-e "${script}"`, cwd: dir })).lastInsertRowid)
const row = (id: number): { play_minutes: number; last_played: number | null } => db.prepare('SELECT play_minutes, last_played FROM library WHERE id = ?').get(id) as never

describe('lancement d’un exécutable ajouté à la main', () => {
  it('lance le processus, notifie début et fin, et signale une fermeture rapide avec sa sortie', async () => {
    const id = addExe('Mon jeu', "console.log('salut'); setTimeout(() => process.exit(2), 300)")
    expect(await launch(id)).toEqual({ ok: true })
    expect(sessions[0]).toMatchObject({ entryId: id, running: true })
    expect(isRunning(id)).toBe(true)
    const end = await ended(id)
    expect(isRunning(id)).toBe(false)
    expect(end.quickExit?.log).toContain('salut')
    expect(row(id).last_played).not.toBeNull()
  })

  it('une sortie propre (code 0) très rapide n’est pas signalée comme un échec : lanceur ou raccourci qui passe la main', async () => {
    const id = addExe('Raccourci', 'process.exit(0)')
    expect(await launch(id)).toEqual({ ok: true })
    const end = await ended(id)
    expect(end.quickExit).toBeUndefined()
  })

  it('compte le temps de jeu et enregistre la session (partie de 2 minutes simulées)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'))
    const id = addExe('Long jeu', 'setTimeout(() => {}, 600)')
    expect(await launch(id)).toEqual({ ok: true })
    vi.setSystemTime(new Date('2026-10-05T12:02:10Z')) // 130 s plus tard, pendant que le processus tourne encore
    const end = await ended(id)
    expect(end.quickExit).toBeUndefined()
    expect(row(id).play_minutes).toBe(2)
    expect(end.playMinutes).toBe(2)
    expect(db.prepare('SELECT minutes FROM play_sessions WHERE entry_id = ?').all(id)).toEqual([{ minutes: 2 }])
    expect(getStats(db, id)).toMatchObject({ playMinutes: 2, sessions: 1, rank: 1 })
  })

  it('un seul jeu à la fois ; l’arrêt demandé ne compte pas comme un échec', async () => {
    const a = addExe('A', 'setTimeout(() => {}, 30000)')
    const b = addExe('B', 'setTimeout(() => {}, 300)')
    expect(await launch(a)).toEqual({ ok: true })
    expect(await launch(b)).toEqual({ ok: false, error: 'otherRunning' })
    expect(await launch(a)).toEqual({ ok: false, error: 'running' })
    stopGame(a)
    const end = await ended(a)
    expect(end.quickExit).toBeUndefined()
    expect(isRunning(a)).toBe(false)
  })

  it('refuse proprement : exécutable disparu, adresse de launcher non autorisée', async () => {
    expect(await launch(addExe('Disparu', 'x', join(dir, 'absent.exe')))).toEqual({ ok: false, error: 'noFile' })
    // Adresse qui n'est pas celle d'un launcher connu : jamais ouverte (le lancement par launcher a ses tests dans launcherUri.test.ts, avec de faux processus).
    const uri = upsertExternalEntry(db, { kind: 'launcher', source: 'steam', nativeId: '10', title: 'Steam', launch: { type: 'uri', uri: 'steam://rungameid/10' } })
    if (!uri.ok) throw new Error('refusé')
    db.prepare('UPDATE library SET launch = ? WHERE id = ?').run(JSON.stringify({ type: 'uri', uri: 'http://exemple.invalid/x' }), uri.id)
    expect(await launch(uri.id)).toEqual({ ok: false, error: 'unsupported' })
    expect(await launch(9999)).toEqual({ ok: false, error: 'noFile' })
  })
})

describe('ROM confiée à un émulateur personnalisé', () => {
  const addRom = (emu: string | null): { id: number; rom: string } => {
    const rom = join(dir, 'Zelda.sfc'); writeFileSync(rom, 'rom')
    const id = Number(db.prepare("INSERT INTO library (console, title, path, size, match, added_at, emulator_id) VALUES ('snes', 'Zelda', ?, 3, 'hash', 0, ?)").run(rom, emu).lastInsertRowid)
    return { id, rom }
  }
  const addEmu = (args: string): string => {
    const r = saveCustomEmulator(db, { name: 'Mon émulateur', exe: NODE, args, consoles: ['snes'], extensions: ['sfc'] })
    if (!r.ok) throw new Error('refusé')
    return r.id
  }

  it('lance l’émulateur avec la ligne de commande du modèle (variables remplacées, chemin avec espaces intact)', async () => {
    const emu = addEmu('-e "console.log(JSON.stringify(process.argv.slice(1))); process.exit(1)" "{rom}" {console} {name}')
    const { id, rom } = addRom(emu)
    expect(await launch(id)).toEqual({ ok: true })
    const end = await ended(id)
    expect(JSON.parse(end.quickExit!.log!)).toEqual([rom, 'snes', 'Zelda'])
    expect(row(id).last_played).not.toBeNull()
  })

  it('le choix par défaut de la console s’applique quand le jeu n’a pas de choix propre', async () => {
    const emu = addEmu('-e "console.log(\'par défaut\'); process.exit(1)"')
    const { id } = addRom(null)
    db.prepare("INSERT INTO settings (key, value) VALUES ('emulatorDefaults', ?)").run(JSON.stringify({ snes: emu }))
    expect(await launch(id)).toEqual({ ok: true })
    expect((await ended(id)).quickExit?.log).toContain('par défaut')
  })

  it('refuse proprement : émulateur dont l’exécutable a disparu, fichier du jeu absent', async () => {
    const emu = addEmu('"{rom}"')
    const { id, rom } = addRom(emu)
    db.prepare('UPDATE custom_emulators SET exe = ? WHERE id = ?').run(join(dir, 'disparu.exe'), emu)
    expect(await launch(id)).toEqual({ ok: false, error: 'notInstalled', detail: 'Mon émulateur' })
    db.prepare('UPDATE custom_emulators SET exe = ? WHERE id = ?').run(NODE, emu)
    rmSync(rom)
    db.prepare('UPDATE library SET missing = 1 WHERE id = ?').run(id)
    expect(await launch(id)).toEqual({ ok: false, error: 'noFile' })
  })
})
