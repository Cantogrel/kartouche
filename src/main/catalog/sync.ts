import type { DatabaseSync } from 'node:sqlite'
import { CONSOLES } from '@shared/consoles'
import type { SyncProgress, SyncResult } from '@shared/catalog'
import type { Settings } from '@shared/settings'
import { pruneUnknownConsoles, replaceConsole } from './catalogStore'
import { fetchConsoleCatalog, type Fetcher } from './libretro'
import { fetchSwitchCatalog } from './switch'

/**
 * Synchronise les consoles demandées, une à une ; l'échec d'une console n'arrête pas les autres.
 * Les consoles dont le catalogue vient d'IGDB (Switch) sont sautées sans clé IGDB.
 */
export async function syncCatalog(db: DatabaseSync, ids: string[] | undefined, onProgress: (p: SyncProgress) => void, get?: Fetcher,
  settings?: Settings, switchFetch: typeof fetchSwitchCatalog = fetchSwitchCatalog): Promise<SyncResult> {
  pruneUnknownConsoles(db, CONSOLES.map((c) => c.id))
  const hasIgdb = !!settings && settings.igdbClientId !== '' && settings.igdbClientSecret !== ''
  const defs = CONSOLES.filter((c) => (!ids || ids.includes(c.id)) && (c.dat !== 'igdb' || hasIgdb))
  const result: SyncResult = { synced: 0, failed: [] }
  let done = 0
  for (const def of defs) {
    try {
      if (def.dat === 'igdb') replaceConsole(db, def.id, await switchFetch(settings!), null)
      else {
        const { rows, version } = await fetchConsoleCatalog(def, get)
        replaceConsole(db, def.id, rows, version)
      }
      result.synced++
      onProgress({ console: def.id, done: ++done, total: defs.length })
    } catch (e) {
      result.failed.push(def.id)
      onProgress({ console: def.id, done: ++done, total: defs.length, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
