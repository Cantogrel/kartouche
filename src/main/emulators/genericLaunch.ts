import { spawn } from 'node:child_process'

/*
 * Lancement d'un processus quelconque (émulateur personnalisé, exécutable ajouté à la main, jeu de launcher) : sans Electron, pour pouvoir être testé avec de
 * vrais processus. Le suivi de la session (temps de jeu, fermeture, notification) reste dans launcher.ts, qui sait déjà arrêter proprement un processus par son pid.
 */

export interface RunSpec {
  exe: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface RunOutcome {
  elapsedMs: number
  exitCode: number | null
  /** Fin de la sortie standard/erreur (les jeux graphiques n'écrivent en général rien) : sert de diagnostic si le processus se ferme tout de suite. */
  captured: string
  /** Le processus n'a pas pu démarrer (fichier introuvable, droits…). */
  error?: string
}

export interface RunHandle {
  pid: number
  done: Promise<RunOutcome>
}

const CAPTURE_MAX = 8000

/** Démarre le processus et renvoie son pid tout de suite ; `done` se résout à sa fin, ou à son échec de démarrage. Ne lève jamais. */
export function runProcess(spec: RunSpec): RunHandle {
  const started = Date.now()
  let captured = ''
  const base = { cwd: spec.cwd, env: spec.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], windowsHide: false }
  // Node refuse de lancer directement un .bat/.cmd (EINVAL) : on passe par cmd.exe, chaque argument entre guillemets.
  const child = /\.(bat|cmd)$/i.test(spec.exe)
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[spec.exe, ...spec.args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ')}"`], { ...base, windowsVerbatimArguments: true })
    : spawn(spec.exe, spec.args, base)
  const onOutput = (chunk: Buffer): void => { captured = (captured + chunk.toString('utf8')).slice(-CAPTURE_MAX) }
  child.stdout?.on('data', onOutput)
  child.stderr?.on('data', onOutput)
  const done = new Promise<RunOutcome>((resolve) => {
    let over = false
    const finish = (exitCode: number | null, error?: string): void => {
      if (over) return
      over = true
      resolve({ elapsedMs: Date.now() - started, exitCode, captured, error })
    }
    child.on('error', (e) => finish(null, e.message))
    child.on('exit', (code) => finish(code))
  })
  return { pid: child.pid ?? 0, done }
}
