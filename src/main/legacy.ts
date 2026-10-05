import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Éléments du dossier userData de RomVault (ancien nom du produit) à reprendre : chemin des données choisi par l'utilisateur, stockage local de Chromium. */
const CARRIED = ['bootstrap.json', 'Local Storage'] as const

/**
 * Kartouche s'appelait RomVault : Electron range userData sous le nom du produit (`%APPDATA%\RomVault` devient `%APPDATA%\Kartouche`),
 * donc `bootstrap.json` (dossier de données choisi à la main) et le stockage local de Chromium ne seraient plus retrouvés.
 * Copie, jamais déplacement : l'ancien dossier reste intact (retour à une ancienne version possible), et un élément déjà
 * présent côté Kartouche n'est jamais écrasé. À appeler avant que Chromium ouvre son stockage (avant `whenReady`).
 * Renvoie les éléments repris.
 */
export function migrateLegacyUserData(userDataDir: string, legacyDirs: readonly string[]): string[] {
  const carried: string[] = []
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase() // Windows : insensible à la casse
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
