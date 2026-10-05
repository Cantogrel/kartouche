import { cpSync, existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

/** Éléments du dossier userData de RomVault (ancien nom du produit) à reprendre : chemin des données choisi par l'utilisateur, stockage local de Chromium. */
const CARRIED = ['bootstrap.json', 'Local Storage'] as const

/**
 * Ce que Chromium/Electron génère tout seul dans userData et recrée au besoin : sans valeur une fois Kartouche installé.
 * Liste fermée : tout ce qui n'y figure pas (par exemple un dossier `data` laissé par une très ancienne disposition) est une donnée
 * de l'utilisateur et n'est JAMAIS supprimé automatiquement.
 */
const DISPOSABLE = [
  'Cache', 'Code Cache', 'DIPS', 'DawnGraphiteCache', 'DawnWebGPUCache', 'DevToolsActivePort', 'GPUCache', 'GPUPersistentCache',
  'GrShaderCache', 'Local State', 'Network', 'Preferences', 'Session Storage', 'ShaderCache', 'Shared Dictionary', 'blob_storage',
  'declarative_performance_observer.db', 'declarative_performance_observer.db-journal', 'Crashpad', 'Dictionaries', 'SharedStorage',
  'Service Worker', 'IndexedDB', 'WebStorage', 'Trust Tokens', 'VideoDecodeStats', 'component_crx_cache', 'extensions_crx_cache',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', '.updaterId'
] as const

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase() // Windows : insensible à la casse

/**
 * Kartouche s'appelait RomVault : Electron range userData sous le nom du produit (`%APPDATA%\RomVault` devient `%APPDATA%\Kartouche`),
 * donc `bootstrap.json` (dossier de données choisi à la main) et le stockage local de Chromium ne seraient plus retrouvés.
 * Copie, jamais déplacement : l'ancien dossier reste intact, et un élément déjà présent côté Kartouche n'est jamais écrasé.
 * À appeler avant que Chromium ouvre son stockage (avant `whenReady`). Renvoie les éléments repris.
 */
export function migrateLegacyUserData(userDataDir: string, legacyDirs: readonly string[]): string[] {
  const carried: string[] = []
  for (const legacy of legacyDirs) {
    if (same(legacy, userDataDir) || !existsSync(legacy)) continue
    for (const name of CARRIED) {
      const from = join(legacy, name)
      const to = join(userDataDir, name)
      if (carried.includes(name) || !existsSync(from) || existsSync(to)) continue
      try {
        cpSync(from, to, { recursive: true, errorOnExist: false, force: false })
        carried.push(name)
      } catch { /* élément verrouillé ou illisible : on repart de zéro pour celui-là, sans bloquer le démarrage */ }
    }
  }
  return carried
}

/**
 * Retire de l'ancien dossier userData ce qui ne sert plus : les éléments repris (une fois leur copie présente côté Kartouche) et les
 * fichiers générés par Chromium. Le dossier lui-même disparaît s'il ne reste rien. Tout élément inconnu est laissé en place.
 * À n'appeler que pour l'application installée : en développement, l'ancien dossier peut encore servir à une RomVault installée.
 * Renvoie les noms supprimés.
 */
export function retireLegacyUserData(userDataDir: string, legacyDir: string): string[] {
  if (same(legacyDir, userDataDir) || !existsSync(legacyDir)) return []
  const removable = new Set<string>(DISPOSABLE)
  for (const name of CARRIED) if (existsSync(join(userDataDir, name))) removable.add(name)
  const removed: string[] = []
  for (const name of readdirSync(legacyDir)) {
    if (!removable.has(name)) continue
    try {
      rmSync(join(legacyDir, name), { recursive: true, force: true })
      removed.push(name)
    } catch { /* verrouillé : retiré au prochain démarrage */ }
  }
  try { rmdirSync(legacyDir) } catch { /* non vide (éléments inconnus laissés) : on n'y touche pas */ }
  return removed
}

/** Cache de mise à jour de l'ancien produit (`%LOCALAPPDATA%\romvault-updater` : l'installateur téléchargé, ~120 Mo) : sans objet, l'app utilise `kartouche-updater`. */
export function removeLegacyUpdaterCache(localAppData: string | undefined): boolean {
  if (!localAppData) return false
  const dir = join(localAppData, 'romvault-updater')
  if (!existsSync(dir)) return false
  try { rmSync(dir, { recursive: true, force: true }); return !existsSync(dir) } catch { return false }
}
