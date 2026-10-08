import type { PadList, RawPad } from '@shared/pads'
import { lastUsedPad } from './padChoice'
import { classifyPads } from './padList'
import { watchPadList } from './padWatch'

// Liste des manettes pour l'interface. La surveillance PowerShell ne tourne que pendant qu'une page la demande : elle s'arrête d'elle-même quelques secondes après la dernière demande
// (page fermée), et la première réponse attend sa première liste (au plus quelques secondes) pour ne jamais dire « aucune manette » faute d'avoir eu le temps de regarder.
const IDLE_MS = 8000
const FIRST_MS = 4000

let snapshot: RawPad[] | null = null
let stop: (() => void) | null = null
let starting: Promise<void> | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let waiting: (() => void)[] = []

function shutdown(): void {
  if (idle) { clearTimeout(idle); idle = null }
  stop?.()
  stop = null
  starting = null
  snapshot = null
}

function ensureWatcher(cacheDir: string): Promise<void> {
  if (starting) return starting
  starting = watchPadList(cacheDir, (raw) => {
    snapshot = raw
    const w = waiting; waiting = []
    for (const f of w) f()
  }, () => { shutdown(); const w = waiting; waiting = []; for (const f of w) f() })
    .then((s) => { stop = s })
    .catch(() => { shutdown() })
  return starting
}

/** Manettes branchées, interprétées. `ok` est faux si la détection système n'a pas répondu (liste vide qui ne veut pas dire « aucune manette »). */
export async function getPadList(cacheDir: string): Promise<PadList> {
  if (idle) clearTimeout(idle)
  idle = setTimeout(shutdown, IDLE_MS)
  await ensureWatcher(cacheDir)
  if (!snapshot) await new Promise<void>((resolve) => { waiting.push(resolve); setTimeout(resolve, FIRST_MS).unref() })
  return snapshot ? { ok: true, pads: classifyPads(snapshot, lastUsedPad()) } : { ok: false, pads: [] }
}
