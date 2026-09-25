import type { DatabaseSync } from 'node:sqlite'
import { CONSOLES } from '@shared/consoles'
import type { SyncProgress, SyncResult } from '@shared/catalog'
import { pruneUnknownConsoles, replaceConsole } from './catalogStore'
import { fetchConsoleCatalog, type Fetcher } from './libretro'

/** Synchronise les consoles demandées, une à une ; l'échec d'une console n'arrête pas les autres. */
export async function syncCatalog(db: DatabaseSync, ids: string[] | undefined, onProgress: (p: SyncProgress) => void, get?: Fetcher): Promise<SyncResult> {
  pruneUnknownConsoles(db, CONSOLES.map((c) => c.id))
  const defs = CONSOLES.filter((c) => !ids || ids.includes(c.id))
  const result: SyncResult = { synced: 0, failed: [] }
  let done = 0
  for (const def of defs) {
    try {
      const { rows, version } = await fetchConsoleCatalog(def, get)
      replaceConsole(db, def.id, rows, version)
      result.synced++
      onProgress({ console: def.id, done: ++done, total: defs.length })
    } catch (e) {
      result.failed.push(def.id)
      onProgress({ console: def.id, done: ++done, total: defs.length, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
