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
import { connectorStatus, scanConnector, type Connector } from './core'

/** Connecteurs pris en charge (un par launcher ; chacun est ajouté par sa propre étape de la feuille de route). */
export const CONNECTORS: Connector[] = [steamConnector(), epicConnector(), gogConnector(), hydraConnector(), xboxConnector(), eaConnector(), ubisoftConnector(), battleNetConnector(), itchConnector()]

const enabledMap = (db: DatabaseSync): Record<string, boolean> => loadSettings(db).connectors

export const listConnectors = (db: DatabaseSync, connectors: Connector[] = CONNECTORS): Promise<ConnectorStatus[]> =>
  Promise.all(connectors.map((c) => connectorStatus(db, c, enabledMap(db)[c.id] === true)))

/** Analyse un launcher, ou tous ceux qui sont activés (`id` absent) : c'est ce que fait le démarrage de l'application. */
export async function scanConnectors(db: DatabaseSync, id?: string, connectors: Connector[] = CONNECTORS): Promise<ScanReport[]> {
  const enabled = enabledMap(db)
  const targets = id ? connectors.filter((c) => c.id === id) : connectors.filter((c) => enabled[c.id] === true)
  const reports: ScanReport[] = []
  for (const c of targets) reports.push(await scanConnector(db, c))
  return reports
}
