import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkWiiUTitle } from '../../library/content/wiiu'
import type { ContentInstaller } from './types'

// Cemu (Wii U) : mises à jour et DLC par ses « chemins de jeux » (Options > Général > Chemins de jeux, `<GamePaths>` de settings.xml). Vérifié dans le code de Cemu
// (CafeTitleList.cpp, `RefreshWorkerThread`/`ScanGamePath`, et GameInfo/`GetGameInfo`) : Cemu parcourt récursivement chaque chemin de jeux et y découvre TOUT titre — jeu, mise à jour
// (0005000E-<même id bas>) ou DLC (0005000C-<même id bas>) — qu'il soit extrait (`code/` + `content/` + `meta/`) ou au format NUS/WUP (`title.tmd` + `title.tik` + `.app`,
// déchiffré par Cemu lui-même avec la clé commune qu'il embarque). Au lancement d'un jeu il associe lui-même la mise à jour et le DLC de même identifiant (journal : « Update: <chemin> »,
// « DLC: <chemin> »). Kartouche n'installe donc rien dans `mlc01` et ne déchiffre rien : il range le titre sous <roms>/wiiu/.content/ et déclare ce dossier à Cemu. Désinstaller =
// supprimer ce que Kartouche a rangé ; rien n'est écrit dans l'espace de Cemu, donc rien à y défaire (et les titres que l'utilisateur a installés dans `mlc01` ne sont jamais touchés).

export const cemuSettingsFile = (dir: string): string => join(dir, 'settings.xml')
export const cemuContentDir = (romsDir: string): string => join(romsDir, 'wiiu', '.content')

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unesc = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Chemins déjà déclarés dans `<GamePaths>` de settings.xml. */
export function cemuGamePaths(xml: string): string[] {
  const block = /<GamePaths>([\s\S]*?)<\/GamePaths>/.exec(xml)
  if (!block) return []
  return [...block[1].matchAll(/<Entry>([\s\S]*?)<\/Entry>/g)].map((m) => unesc(m[1].trim())).filter(Boolean)
}

/**
 * Ajoute `dir` aux chemins de jeux de Cemu s'il n'y est pas ; les chemins de l'utilisateur sont conservés tels quels. `missing` : le fichier n'a aucune section `<GamePaths>`
 * (jamais écrit par Cemu) — on ne le fabrique pas.
 */
export function registerCemuGamePath(xml: string, dir: string): { text: string; changed: boolean; missing: boolean } {
  if (cemuGamePaths(xml).some((p) => norm(p) === norm(dir))) return { text: xml, changed: false, missing: false }
  const nl = xml.includes('\r\n') ? '\r\n' : '\n'
  const value = esc(dir.replace(/\\/g, '/').replace(/\/+$/, ''))
  const empty = /^([ \t]*)<GamePaths\s*\/>/m.exec(xml)
  if (empty) {
    const indent = empty[1]
    return { text: xml.replace(empty[0], `${indent}<GamePaths>${nl}${indent}    <Entry>${value}</Entry>${nl}${indent}</GamePaths>`), changed: true, missing: false }
  }
  const closing = /^([ \t]*)<\/GamePaths>/m.exec(xml)
  if (closing) return { text: xml.replace(closing[0], `${closing[1]}    <Entry>${value}</Entry>${nl}${closing[0]}`), changed: true, missing: false }
  return { text: xml, changed: false, missing: true }
}

export const cemuInstaller: ContentInstaller = {
  emulatorId: 'cemu',
  managed: true,
  async install(env, item) {
    if (!env.emulator) return { state: 'pending', reason: 'emulatorMissing' }
    if (!existsSync(item.path)) return { state: 'failed', reason: 'error', detail: 'fichier absent' }
    // Cemu ne déclare que ce qu'il sait ouvrir : on vérifie les mêmes exigences que lui, et on dit précisément ce qui manque plutôt que de déclarer un titre qu'il ignorerait.
    const check = await checkWiiUTitle(item.path)
    if (!check.ok) return check.reason === 'ticket' ? { state: 'pending', reason: 'needsKey', detail: check.detail } : { state: 'failed', reason: 'error', detail: check.detail }
    const file = cemuSettingsFile(env.emulator.dir)
    if (!existsSync(file)) return { state: 'pending', reason: 'emulatorMissing', detail: "Cemu n'a pas encore créé sa configuration (settings.xml)" }
    const current = await readFile(file, 'utf8')
    const { text, changed, missing } = registerCemuGamePath(current, cemuContentDir(env.romsDir))
    if (missing) return { state: 'failed', reason: 'error', detail: 'settings.xml de Cemu sans section <GamePaths> : configuration non modifiée' }
    // Kartouche ne possède rien côté Cemu : `[]` (déclarer un dossier dans sa configuration n'est pas un fichier à retirer avec le contenu).
    if (!changed) return { state: 'installed', emuFiles: [] }
    // Cemu réécrit settings.xml à sa fermeture : un fichier modifié pendant qu'il tourne serait écrasé.
    if (await env.isRunning('Cemu.exe')) return { state: 'pending', reason: 'emulatorRunning' }
    const tmp = `${file}.romvault-tmp`
    await writeFile(tmp, text)
    await rename(tmp, file)
    return { state: 'installed', emuFiles: [] }
  }
}
