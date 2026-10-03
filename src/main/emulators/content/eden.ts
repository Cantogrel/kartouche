import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { patchIni } from '../configure'
import type { ContentInstaller } from './types'

// Eden (Switch) : mises à jour et DLC par son mécanisme « External Content » (Configuration > Général). Vérifié dans le code d'Eden
// (core/file_sys/registered_cache.cpp, `ExternalContentProvider`) ET dans le binaire installé (v0.2.1 : « External Content », `external_content_dirs`) :
// Eden parcourt récursivement chaque dossier listé, ouvre chaque .nsp/.xci, y lit tickets et métadonnées (les clés de titre des tickets sont enregistrées
// par le chargeur de NSP lui-même) et propose les mises à jour (plusieurs versions possibles) et DLC au jeu concerné — SANS rien installer dans le NAND.
// RomVault n'a donc rien à écrire dans le NAND ni à déchiffrer : il range les contenus sous <roms>/switch/.content/ et déclare ce dossier à Eden
// (qt-config.ini, `Paths\external_content_dirs`). Rien n'est copié dans le NAND, donc rien à défaire : retirer le fichier suffit à retirer le contenu.

export const edenConfigFile = (dir: string): string => join(dir, 'user', 'config', 'qt-config.ini')

const SIZE_KEY = 'Paths\\external_content_dirs\\size'
const pathKey = (i: number): string => `Paths\\external_content_dirs\\${i}\\path`

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
/** Valeur d'un QSettings .ini : guillemets éventuels, barres obliques inverses doublées. */
const unquote = (v: string): string => v.trim().replace(/^"(.*)"$/, '$1').replace(/\\\\/g, '\\')

/** Dossiers de contenu externe déjà déclarés dans le qt-config.ini d'Eden (section [UI]). */
export function externalContentDirs(ini: string): string[] {
  const out: string[] = []
  for (const line of ini.split(/\r?\n/)) {
    const m = /^Paths\\external_content_dirs\\\d+\\path=(.*)$/.exec(line)
    if (m && unquote(m[1])) out.push(unquote(m[1]))
  }
  return out
}

/** Ajoute `dir` à la liste d'Eden si elle ne s'y trouve pas ; les entrées de l'utilisateur sont conservées telles quelles. */
export function registerExternalDir(ini: string, dir: string): { text: string; changed: boolean } {
  const existing = externalContentDirs(ini)
  if (existing.some((d) => norm(d) === norm(dir))) return { text: ini, changed: false }
  const n = existing.length
  // Barres obliques normales : pas de doublement de barre inverse à gérer, et Eden les réécrit telles quelles.
  const value = `${dir.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  return { text: patchIni(ini, { UI: { [SIZE_KEY]: n + 1, [pathKey(n + 1)]: value } }, '='), changed: true }
}

export const edenContentDir = (romsDir: string): string => join(romsDir, 'switch', '.content')

export const edenInstaller: ContentInstaller = {
  emulatorId: 'eden',
  managed: true,
  async install(env, item) {
    if (!env.emulator) return { state: 'pending', reason: 'emulatorMissing' }
    if (!existsSync(item.path)) return { state: 'failed', reason: 'error', detail: 'fichier absent' }
    const file = edenConfigFile(env.emulator.dir)
    const current = existsSync(file) ? await readFile(file, 'utf8') : ''
    const { text, changed } = registerExternalDir(current, edenContentDir(env.romsDir))
    // RomVault ne possède rien dans l'espace d'Eden (il lit nos fichiers en place) : `[]`, pour ne jamais être pris pour un contenu « sans suivi ».
    if (!changed) return { state: 'installed', emuFiles: [] }
    // Eden réécrit son qt-config.ini à sa fermeture : un fichier modifié pendant qu'il tourne serait écrasé.
    if (await env.isRunning('eden.exe')) return { state: 'pending', reason: 'emulatorRunning' }
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.romvault-tmp`
    await writeFile(tmp, text)
    await rename(tmp, file)
    return { state: 'installed', emuFiles: [] }
  }
}
