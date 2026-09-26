import { app } from 'electron'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AppPaths } from '@shared/ipc'

/** Le dossier de données est choisi avant d'ouvrir la base : il est mémorisé à part, dans userData. */
const bootstrapFile = (): string => join(app.getPath('userData'), 'bootstrap.json')

function defaultDataDir(): string {
  // Dev : <racine du projet>\data. Packagé : <dossier de l'exe>\data (l'installateur le met à l'abri pendant les mises à jour, voir build/installer.nsh).
  return app.isPackaged ? join(dirname(app.getPath('exe')), 'data') : join(app.getAppPath(), 'data')
}

export function resolveDataDir(): string {
  try {
    const cfg = JSON.parse(readFileSync(bootstrapFile(), 'utf8')) as { dataDir?: unknown }
    if (typeof cfg.dataDir === 'string' && cfg.dataDir) return cfg.dataDir
  } catch { /* pas encore de bootstrap */ }
  return defaultDataDir()
}

export function setDataDir(dataDir: string): void {
  mkdirSync(dirname(bootstrapFile()), { recursive: true })
  writeFileSync(bootstrapFile(), JSON.stringify({ dataDir }, null, 2))
}

export function buildPaths(dataDir: string): AppPaths {
  return {
    dataDir,
    roms: join(dataDir, 'roms'),
    emulators: join(dataDir, 'emulators'),
    bios: join(dataDir, 'bios'),
    saves: join(dataDir, 'saves'),
    cache: join(dataDir, 'cache'),
    dats: join(dataDir, 'dats'),
    logs: join(dataDir, 'logs')
  }
}

export function ensureDirs(paths: AppPaths): void {
  for (const p of Object.values(paths)) if (!existsSync(p)) mkdirSync(p, { recursive: true })
}
