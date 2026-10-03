import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// Aides des tests RÉELS (voir real-emulators.test.ts et ../../library/content/real-content.test.ts).

const killTree = (pid: number | undefined): void => { if (pid) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined) }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Lance l'émulateur et attend qu'une ligne de son journal corresponde à `done` (ou le délai) ; le ferme ensuite. Renvoie le journal. */
export async function launchUntil(exe: string, args: string[], cwd: string, log: string, done: RegExp, timeoutMs: number): Promise<string> {
  rmSync(log, { force: true }) // jamais un journal d'une session précédente
  const child = spawn(exe, args, { cwd, stdio: 'ignore', windowsHide: false })
  const start = Date.now()
  let text = ''
  while (Date.now() - start < timeoutMs) {
    await sleep(1000)
    text = existsSync(log) ? readFileSync(log, 'utf8') : ''
    if (done.test(text)) break
  }
  killTree(child.pid)
  await sleep(2500)
  return existsSync(log) ? readFileSync(log, 'utf8') : text
}

/** Sauvegarde puis restaure des fichiers d'émulateur autour d'un essai. */
export function guard(files: string[]): { restore: () => void } {
  const saved = files.map((f) => ({ f, data: existsSync(f) ? readFileSync(f) : null }))
  return { restore: () => { for (const s of saved) { if (s.data) writeFileSync(s.f, s.data); else rmSync(s.f, { force: true }) } } }
}

