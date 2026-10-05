import type { DatabaseSync } from 'node:sqlite'
import type { ConnectorStatus, ScanReport } from '@shared/connectors'
import { loadSettings } from '../db/settingsStore'
import { steamConnector } from './steam'
import { epicConnector } from './epic'
import { gogConnector } from './gog'
import { hydraConnector } from './hydra'
import { xboxConnector } from './xbox'
import { eaConnector } from './ea'
import { ubisoftConnector } from './ubisoft'
import { battleNetConnector } from './battlenet'
import { itchConnector } from './itch'
import { connectorStatus, detectConnector, scanConnector, type Connector } from './core'

/** Connecteurs pris en charge (un par launcher ; chacun est ajouté par sa propre étape de la feuille de route). */
export const CONNECTORS: Connector[] = [steamConnector(), epicConnector(), gogConnector(), hydraConnector(), xboxConnector(), eaConnector(), ubisoftConnector(), battleNetConnector(), itchConnector()]

const enabledMap = (db: DatabaseSync): Record<string, boolean> => loadSettings(db).connectors

/** Dernière détection de chaque launcher (la détection lit le registre, parfois plusieurs secondes : on ne la refait pas à chaque ouverture de la page). */
const detected = new Map<string, boolean>()

/**
 * État des launchers. `detect: false` répond tout de suite avec la dernière détection connue (`null` si jamais faite) ; `true` détecte
 * vraiment, tous les launchers en parallèle, et mémorise le résultat.
 */
export async function listConnectors(db: DatabaseSync, connectors: Connector[] = CONNECTORS, detect = true): Promise<ConnectorStatus[]> {
  if (detect) await Promise.all(connectors.map(async (c) => { detected.set(c.id, await detectConnector(c)) }))
  const enabled = enabledMap(db)
  return connectors.map((c) => connectorStatus(db, c, enabled[c.id] === true, detected.get(c.id) ?? null))
}

/** Analyse un launcher, ou tous ceux qui sont activés (`id` absent) : c'est ce que fait le démarrage de l'application. */
export async function scanConnectors(db: DatabaseSync, id?: string, connectors: Connector[] = CONNECTORS): Promise<ScanReport[]> {
  const enabled = enabledMap(db)
  const targets = id ? connectors.filter((c) => c.id === id) : connectors.filter((c) => enabled[c.id] === true)
  const reports: ScanReport[] = []
  for (const c of targets) reports.push(await scanConnector(db, c))
  return reports
}
