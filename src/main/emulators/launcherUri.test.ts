import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GameSession } from '@shared/emulators'
import { migrate } from '../db/migrations'
import { upsertExternalEntry } from '../library/external'
import { runLauncherGame, type UriLaunchDeps } from './launcherUri'

const h = vi.hoisted(() => ({ deps: null as unknown as UriLaunchDeps }))
vi.mock('electron', () => ({ app: { getLocale: () => 'fr', getAppPath: () => '' } }))
vi.mock('./quit', () => ({
  anyGamepadConnected: async () => false, closeGracefully: (pid: number) => { try { process.kill(pid) } catch { /* déjà terminé */ } },
  connectedXInputPads: async () => 0, connectedXInputSlots: async () => [], watchQuitChord: async () => () => undefined
}))
vi.mock('./launcherUri', async (orig) => ({ ...(await orig<typeof import('./launcherUri')>()), realUriDeps: new Proxy({}, { get: (_t, k) => (h.deps as never)[k] }) }))

const { isRunning, launchGame, stopGame } = await import('./launcher')
const { realUriDeps } = await vi.importActual<typeof import('./launcherUri')>('./launcherUri')

/** Faux Windows : un script décrit, à chaque relevé, les processus présents dans le dossier du jeu. */
function fakeDeps(script: number[][], over: Partial<UriLaunchDeps> = {}): UriLaunchDeps & { opened: string[]; polls: number } {
  let clock = 0
  const d = {
    opened: [] as string[], polls: 0,
    protocolRegistered: async () => true,
    open: (u: string) => { d.opened.push(u) },
    processesIn: async (): Promise<number[]> => { const r: number[] = script[Math.min(d.polls, script.length - 1)] ?? []; d.polls++; return r },
    sleep: async (ms: number) => { clock += ms },
    now: () => clock,
    ...over
  }
  return d
}

describe('runLauncherGame', () => {
  const base = { uri: 'steam://rungameid/1', dir: 'C:\\g', cancelled: () => false, onStart: () => undefined }
  it('ouvre l’adresse, attend le démarrage du jeu, puis sa fin (deux relevés vides)', async () => {
    const d = fakeDeps([[], [], [10], [10, 11], [11], [], [11], [], []])
    let seen: number[] = []
    const r = await runLauncherGame({ ...base, deps: d, onStart: (pids) => { seen = pids() } })
    expect(d.opened).toEqual(['steam://rungameid/1'])
    expect(seen).toEqual([10])
    expect(r.status).toBe('ended')
    if (r.status === 'ended') expect(r.endedAt).toBeGreaterThan(r.startedAt)
    expect(d.polls).toBe(9) // le relevé vide isolé ([]) n'a pas mis fin à la partie
  })
  it('schéma sans application associée : rien n’est ouvert', async () => {
    const d = fakeDeps([[]], { protocolRegistered: async () => false })
    expect(await runLauncherGame({ ...base, deps: d })).toEqual({ status: 'noProtocol' })
    expect(d.opened).toEqual([])
    expect(await runLauncherGame({ ...base, uri: 'pas une adresse', deps: d })).toEqual({ status: 'noProtocol' })
  })
  it('shell:AppsFolder ne demande pas d’application de schéma', async () => {
    const d = fakeDeps([[5], [], []], { protocolRegistered: async () => { throw new Error('ne doit pas être appelé') } })
    expect((await runLauncherGame({ ...base, uri: 'shell:AppsFolder\\A_b!Game', deps: d })).status).toBe('ended')
  })
  it('le jeu ne démarre jamais : délai dépassé', async () => {
    const d = fakeDeps([[]])
    expect(await runLauncherGame({ ...base, deps: d, appearTimeoutMs: 10_000 })).toEqual({ status: 'neverStarted' })
  })
  it('annulation pendant l’attente, et pendant la partie', async () => {
    expect(await runLauncherGame({ ...base, deps: fakeDeps([[]]), cancelled: () => true })).toEqual({ status: 'cancelled' })
    let n = 0
    const r = await runLauncherGame({ ...base, deps: fakeDeps([[7]]), cancelled: () => ++n > 3 })
    expect(r.status).toBe('ended')
  })
  it('une erreur de relevé ne met pas fin à la partie', async () => {
    let calls = 0
    const d = fakeDeps([[9]], { processesIn: async () => { calls++; if (calls === 2) throw new Error('powershell'); return calls > 5 ? [] : [9] } })
    expect((await runLauncherGame({ ...base, deps: d })).status).toBe('ended')
    expect(calls).toBeGreaterThan(5)
  })
})

describe('lancement d’un jeu de launcher dans launchGame', () => {
  let dir: string
  let db: DatabaseSync
  let sessions: GameSession[]
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kuri-')); db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db); sessions = [] })
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
  const notify = (s: GameSession): void => { sessions.push(s) }
  const add = (spec: Record<string, unknown>): number => { const r = upsertExternalEntry(db, { kind: 'launcher', source: 'steam', nativeId: '1', title: 'Jeu', launch: spec as never }); if (!r.ok) throw new Error('add'); return r.id }
  const launch = (id: number): ReturnType<typeof launchGame> => launchGame(db, id, notify, join(dir, 'cache'), join(dir, 'saves'))
  const ended = async (id: number): Promise<GameSession> => { for (let i = 0; i < 400; i++) { const e = sessions.find((s) => s.entryId === id && !s.running); if (e) return e; await new Promise((r) => setTimeout(r, 10)) } throw new Error('pas terminée') }

  it('lance par l’adresse du launcher, suit la partie et compte le temps de jeu', async () => {
    h.deps = fakeDeps([[], [4242], [4242], [], []])
    const id = add({ type: 'uri', uri: 'steam://rungameid/1', installDir: join(dir, 'jeu') })
    expect(await launch(id)).toEqual({ ok: true })
    expect(sessions[0]).toMatchObject({ entryId: id, running: true })
    expect(isRunning(id)).toBe(true)
    const end = await ended(id)
    expect(end.quickExit).toBeUndefined()
    expect(isRunning(id)).toBe(false)
    expect((h.deps as ReturnType<typeof fakeDeps>).opened).toEqual(['steam://rungameid/1'])
    expect(db.prepare('SELECT last_played FROM library WHERE id = ?').get(id)).not.toEqual({ last_played: null })
  })
  it('launcher absent : l’exécutable connu lance le jeu directement', async () => {
    h.deps = fakeDeps([[]], { protocolRegistered: async () => false })
    const id = add({ type: 'uri', uri: 'steam://rungameid/1', installDir: dir, exe: process.execPath, args: '-e "setTimeout(() => {}, 200)"', cwd: dir })
    expect(await launch(id)).toEqual({ ok: true })
    const end = await ended(id)
    expect(end.quickExit).toBeUndefined()
    expect((h.deps as ReturnType<typeof fakeDeps>).opened).toEqual([])
  })
  it('launcher absent et aucun exécutable : message clair, pas de plantage', async () => {
    h.deps = fakeDeps([[]], { protocolRegistered: async () => false })
    const id = add({ type: 'uri', uri: 'steam://rungameid/1', installDir: dir })
    expect(await launch(id)).toEqual({ ok: true })
    expect((await ended(id)).quickExit?.log).toContain('Launcher not installed')
    expect(isRunning(id)).toBe(false)
  })
  it('« Fermer le jeu » pendant l’attente du démarrage arrête l’attente', async () => {
    h.deps = fakeDeps([[]], { sleep: async () => { await new Promise((r) => setTimeout(r, 5)) }, now: () => Date.now() })
    const id = add({ type: 'uri', uri: 'steam://rungameid/1', installDir: dir })
    expect(await launch(id)).toEqual({ ok: true })
    expect(isRunning(id)).toBe(true)
    stopGame(id)
    const end = await ended(id)
    expect(end.quickExit).toBeUndefined()
    expect(isRunning(id)).toBe(false)
  })
  it('adresse refusée (schéma non autorisé) : jamais ouverte', async () => {
    h.deps = fakeDeps([[]])
    const id = add({ type: 'uri', uri: 'steam://x', installDir: dir })
    db.prepare('UPDATE library SET launch = ? WHERE id = ?').run(JSON.stringify({ type: 'uri', uri: 'http://evil.example/x', installDir: dir }), id)
    expect(await launch(id)).toEqual({ ok: false, error: 'unsupported' })
    expect((h.deps as ReturnType<typeof fakeDeps>).opened).toEqual([])
  })
})

describe.runIf(process.platform === 'win32')('relevé réel des processus d’un dossier', () => {
  it('retrouve un vrai processus lancé depuis le dossier, puis plus rien après sa fin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kproc-'))
    let child: ReturnType<typeof spawn> | null = null
    try {
      const exe = join(dir, 'monjeu.exe')
      copyFileSync(process.execPath, exe)
      child = spawn(exe, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore' })
      await new Promise((r) => setTimeout(r, 2000))
      expect(await realUriDeps.processesIn(dir)).toContain(child.pid)
      expect(await realUriDeps.processesIn(join(dir, 'autre'))).toEqual([])
      child.kill()
      await new Promise((r) => setTimeout(r, 800))
      expect(await realUriDeps.processesIn(dir)).toEqual([])
      expect(await realUriDeps.protocolRegistered('http')).toBe(true)
      expect(await realUriDeps.protocolRegistered('kartouche-inexistant')).toBe(false)
    } finally { child?.kill(); await new Promise((r) => setTimeout(r, 500)); rmSync(dir, { recursive: true, force: true }) }
  }, 60000)
})
