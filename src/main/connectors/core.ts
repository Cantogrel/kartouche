import type { DatabaseSync } from 'node:sqlite'
import type { GameSource } from '@shared/launch'
import { launchSpecOf, sanitizeDetected, type ConnectorStatus, type DetectedGame, type ScanReport } from '@shared/connectors'
import { upsertExternalEntry } from '../library/external'

/*
 * Cadre commun des connecteurs de launchers. Un connecteur (voir shared/connectors.ts pour la règle « jamais de secret de compte ») ne fait que détecter
 * le launcher et lister ses jeux ; l'enregistrement, le dédoublonnage et la mise à jour sont ici, identiques pour tous.
 */

export interface Connector {
  id: Exclude<GameSource, 'manual'>
  name: string
  /** Le launcher est-il installé sur ce PC ? Ne doit rien lire d'autre que la présence de ses fichiers. */
  detect(): Promise<boolean>
  /** Jeux installés selon les manifestes locaux du launcher. */
  scan(): Promise<unknown[]>
}

export const gamesOf = (db: DatabaseSync, source: GameSource): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM library WHERE source = ? AND kind = 'launcher'").get(source) as { n: number }).n

export async function connectorStatus(db: DatabaseSync, connector: Connector, enabled: boolean): Promise<ConnectorStatus> {
  let detected = false
  try { detected = await connector.detect() } catch { /* launcher illisible = absent */ }
  return { id: connector.id, name: connector.name, detected, enabled, games: gamesOf(db, connector.id) }
}

/**
 * Lit le launcher et met la bibliothèque à jour : jeux nouveaux ajoutés, jeux connus mis à jour (lancement, dossier) sans toucher à leur titre, leurs
 * surcharges ni leur temps de jeu, jeux disparus conservés mais marqués sans fichier (réinstallés, ils reviennent tels quels).
 */
export async function scanConnector(db: DatabaseSync, connector: Connector): Promise<ScanReport> {
  const report: ScanReport = { id: connector.id, ok: false, found: 0, added: 0, updated: 0, duplicates: 0, gone: 0 }
  let raw: unknown[]
  try {
    if (!(await connector.detect())) return { ...report, error: 'absent' }
    raw = await connector.scan()
  } catch (e) {
    return { ...report, error: e instanceof Error ? e.message : String(e) }
  }
  const seen = new Set<string>()
  const games: DetectedGame[] = []
  for (const r of Array.isArray(raw) ? raw : []) {
    const g = sanitizeDetected(r)
    if (g && !seen.has(g.nativeId)) { seen.add(g.nativeId); games.push(g) }
  }
  report.found = games.length
  for (const g of games) {
    const res = upsertExternalEntry(db, { kind: 'launcher', source: connector.id, nativeId: g.nativeId, title: g.title, launch: launchSpecOf(g) })
    if (!res.ok) { report.duplicates++; continue }
    if (res.created) report.added++; else report.updated++
  }
  // Disparus : tout jeu de ce launcher que la lecture ne renvoie plus.
  const known = db.prepare("SELECT id, native_id FROM library WHERE source = ? AND kind = 'launcher'").all(connector.id) as { id: number; native_id: string | null }[]
  const mark = db.prepare('UPDATE library SET missing = 1 WHERE id = ?')
  for (const k of known) if (k.native_id && !seen.has(k.native_id)) { mark.run(k.id); report.gone++ }
  report.ok = true
  return report
}
