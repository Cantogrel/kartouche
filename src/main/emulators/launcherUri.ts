import { execFile, spawn } from 'node:child_process'

/*
 * Jeu lancé par son launcher d'origine (Steam, Epic, Xbox…) : on ouvre l'adresse du launcher, qui démarre le jeu sans autre action de l'utilisateur, puis on
 * suit la partie en cherchant les processus qui s'exécutent depuis le dossier d'installation du jeu. Sans Electron, pour pouvoir être testé avec de vrais processus.
 */

export interface UriLaunchDeps {
  /** Le schéma (`steam`…) a-t-il une application associée dans Windows ? Sans elle, ouvrir l'adresse ferait apparaître une boîte « Choisir une application ». */
  protocolRegistered(scheme: string): Promise<boolean>
  /** Ouvre l'adresse du launcher (sans attendre). */
  open(uri: string): void
  /** Processus dont l'exécutable est dans ce dossier (ou un sous-dossier). */
  processesIn(dir: string): Promise<number[]>
  sleep(ms: number): Promise<void>
  now(): number
}

export interface UriRunOptions {
  uri: string
  /** Dossier d'installation du jeu : sert à retrouver ses processus. */
  dir: string
  deps: UriLaunchDeps
  /** Attente maximale du démarrage du jeu (le launcher peut devoir se lancer ou se mettre à jour). */
  appearTimeoutMs?: number
  pollMs?: number
  cancelled(): boolean
  /** Le jeu tourne : `pids()` donne ses processus actuels (pour le fermer). */
  onStart(pids: () => number[], startedAt: number): void
}

export type UriRunOutcome =
  | { status: 'noProtocol' | 'neverStarted' | 'cancelled' }
  | { status: 'ended'; startedAt: number; endedAt: number }

export async function runLauncherGame(o: UriRunOptions): Promise<UriRunOutcome> {
  const { deps } = o
  const poll = o.pollMs ?? 2000
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(o.uri)?.[1].toLowerCase()
  if (!scheme) return { status: 'noProtocol' }
  if (scheme !== 'shell' && !(await deps.protocolRegistered(scheme))) return { status: 'noProtocol' }
  deps.open(o.uri)
  const deadline = deps.now() + (o.appearTimeoutMs ?? 120_000)
  let pids: number[] = []
  while (pids.length === 0) {
    if (o.cancelled()) return { status: 'cancelled' }
    if (deps.now() > deadline) return { status: 'neverStarted' }
    await deps.sleep(poll)
    pids = await deps.processesIn(o.dir).catch(() => [])
  }
  const startedAt = deps.now()
  o.onStart(() => pids, startedAt)
  // La partie dure tant qu'un processus du dossier tourne ; deux relevés vides de suite (un lanceur peut passer la main au jeu) marquent la fin.
  let empty = 0
  while (empty < 2) {
    if (o.cancelled()) break
    await deps.sleep(poll)
    const now = await deps.processesIn(o.dir).catch(() => pids)
    if (now.length === 0) empty++
    else { empty = 0; pids = now }
  }
  return { status: 'ended', startedAt, endedAt: deps.now() }
}

const ps = (script: string, env: Record<string, string>): Promise<string> => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000, env: { ...process.env, ...env } }, (_e, out) => resolve(out ?? ''))
})

export const realUriDeps: UriLaunchDeps = {
  protocolRegistered: (scheme) => new Promise((resolve) => {
    execFile('reg', ['query', `HKCR\\${scheme}`, '/v', 'URL Protocol'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err))
  }),
  open: (uri) => {
    const child = /^shell:/i.test(uri)
      ? spawn('explorer.exe', [uri], { detached: true, stdio: 'ignore', windowsHide: false })
      : spawn('rundll32.exe', ['url.dll,FileProtocolHandler', uri], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
  },
  processesIn: async (dir) => {
    const out = await ps(
      "$d = $env:KARTOUCHE_DIR.TrimEnd('\\') + '\\'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }",
      { KARTOUCHE_DIR: dir }
    )
    return out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0)
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now()
}
