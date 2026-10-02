import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { patchIni } from './configure'
import type { Ps2Game } from './pcsx2'

// Cartes mémoire PCSX2 propres à chaque jeu.
//
// PCSX2 n'associe pas de carte à un jeu de lui-même : par défaut deux cartes partagées (Mcd001.ps2, Mcd002.ps2) servent tous les jeux. Il lit en revanche des réglages
// par jeu (`gamesettings/<SERIE>_<CRC>.ini`, ou le fichier donné par `-gamecfg`) qui peuvent redéfinir `[MemoryCards] Slot1_Filename` / `Slot2_Filename`
// (Pcsx2Config::LoadSaveMemcards, appliqué sur les réglages superposés ; vérifié : le journal de PCSX2 affiche « McdSlot 0: [Folder] …\memcards\<nom> »).
// Un nom qui désigne un dossier (FileMcd_SetType) devient une carte « dossier » ; un nom absent est créé tel quel. RomVault crée des cartes dossier
// (un dossier + le fichier `_pcsx2_superblock`, comme FileMcd_CreateNewCard), faciles à sauvegarder, à restaurer et à lire d'un jeu à l'autre sans les mélanger.

export const pcsx2CardNames = (serial: string): [string, string] => [`RomVault-${serial}`, `RomVault-${serial}-2`]

const SUPERBLOCK = '_pcsx2_superblock'

async function createFolderCard(memcards: string, name: string): Promise<string> {
  const dir = join(memcards, name)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, SUPERBLOCK), '')
  }
  return dir
}

// --- Lecture d'une carte mémoire PS2 (fichier .ps2) ---------------------------------------------------------------------------------

export interface CardSave { name: string; files: { name: string; data: Buffer }[] }

const RAW_PAGE = 512
const ECC_PAGE = 528

/**
 * Sauvegardes (dossier + fichiers) d'une carte mémoire PS2 de 8 Mo : superbloc, table d'allocation (FAT) à un niveau d'indirection, répertoire racine, puis un
 * répertoire par sauvegarde. Structures et constantes : pcsx2/SIO/Memcard/MemoryCardFolder.h (superblock, MemoryCardFileEntry). Lecture seule.
 * Renvoie [] si ce n'est pas une carte formatée.
 */
export function readPs2Card(card: Buffer): CardSave[] {
  const page = card.length === 16384 * ECC_PAGE ? ECC_PAGE : card.length === 16384 * RAW_PAGE ? RAW_PAGE : 0
  if (!page || !card.toString('latin1', 0, 28).startsWith('Sony PS2 Memory Card Format')) return []
  const cluster = (c: number): Buffer => {
    if (c < 0 || (c + 1) * 2 > 16384) return Buffer.alloc(0)
    return Buffer.concat([card.subarray(c * 2 * page, c * 2 * page + RAW_PAGE), card.subarray((c * 2 + 1) * page, (c * 2 + 1) * page + RAW_PAGE)])
  }
  const allocOffset = card.readUInt32LE(0x34)
  const allocEnd = card.readUInt32LE(0x38)
  const rootCluster = card.readUInt32LE(0x3c)
  const ifc = card.readUInt32LE(0x50)
  const fat: number[] = []
  const ind = cluster(ifc)
  for (let i = 0; i + 4 <= ind.length; i += 4) {
    const fc = ind.readUInt32LE(i)
    if (fc === 0xffffffff || fc === 0) continue
    const data = cluster(fc)
    for (let j = 0; j + 4 <= data.length; j += 4) fat.push(data.readUInt32LE(j))
  }
  const chain = (start: number): number[] => {
    const out: number[] = []
    for (let c = start, guard = 0; c !== 0x7fffffff && c < allocEnd && guard < 20000; guard++) {
      out.push(c)
      const next = fat[c]
      if (next === undefined || !(next & 0x80000000)) break
      c = next & 0x7fffffff
    }
    return out
  }
  const readChain = (start: number, length: number): Buffer => Buffer.concat(chain(start).map((c) => cluster(allocOffset + c))).subarray(0, length)
  const entries = (start: number, count: number): { mode: number; length: number; cluster: number; name: string }[] => {
    const raw = readChain(start, count * 512)
    const out: { mode: number; length: number; cluster: number; name: string }[] = []
    for (let i = 0; i + 512 <= raw.length; i += 512) {
      const mode = raw.readUInt32LE(i)
      if (!(mode & 0x8000)) continue
      out.push({ mode, length: raw.readUInt32LE(i + 4), cluster: raw.readUInt32LE(i + 16), name: raw.toString('latin1', i + 64, i + 96).replace(/\0.*$/s, '') })
    }
    return out
  }
  const saves: CardSave[] = []
  const rootRaw = readChain(rootCluster, 512)
  if (rootRaw.length < 512) return []
  const root = entries(rootCluster, rootRaw.readUInt32LE(4))
  for (const d of root) {
    if (!(d.mode & 0x20) || d.name === '.' || d.name === '..') continue
    const files = entries(d.cluster, d.length)
      .filter((f) => f.mode & 0x10)
      .map((f) => ({ name: f.name, data: f.length ? readChain(f.cluster, f.length) : Buffer.alloc(0) }))
    saves.push({ name: d.name, files })
  }
  return saves
}

/**
 * Une sauvegarde appartient au jeu si le nom de son dossier est « B » + une lettre de région + le numéro de série du jeu (« BESLES-52541… ») : c'est la règle de
 * nommage que Sony impose aux jeux PS2. Un jeu qui s'en écarte garde ses sauvegardes dans la carte partagée, qui n'est jamais modifiée.
 */
export const isGameSave = (dirName: string, serial: string): boolean => /^B[A-Z]/.test(dirName) && dirName.slice(2).toUpperCase().startsWith(serial.toUpperCase())

/**
 * Copie dans la carte dédiée les sauvegardes du jeu qui se trouvent dans les cartes partagées (Mcd001.ps2, Mcd002.ps2), une seule fois (marqueur), sans jamais
 * écrire dans les cartes partagées. Renvoie le nombre de sauvegardes copiées.
 */
export async function migrateSharedSaves(memcards: string, serial: string, target: string, slotFile: string): Promise<number> {
  // Le marqueur est à côté de la carte, pas dedans : PCSX2 range tout fichier de la racine d'une carte dossier dans son propre système de fichiers.
  const marker = `${target}.romvault-migrated`
  if (existsSync(marker)) return 0
  let copied = 0
  const card = await readFile(join(memcards, slotFile)).catch(() => null)
  for (const save of card ? readPs2Card(card) : []) {
    if (!isGameSave(save.name, serial)) continue
    const dest = join(target, save.name)
    if (existsSync(dest)) continue // jamais d'écrasement
    await mkdir(dest, { recursive: true })
    for (const f of save.files) await writeFile(join(dest, f.name), f.data)
    copied++
  }
  await writeFile(marker, '')
  return copied
}

// --- Mise en place avant le lancement -------------------------------------------------------------------------------------------------

export interface CardSetup {
  /** Arguments à insérer avant « -- » : le fichier de réglages à utiliser quand le jeu n'a pas de fichier de réglages sûr à compléter. */
  args: string[]
  names: [string, string]
  migrated: number
}

const hasKey = (text: string, key: string): boolean => new RegExp(`^\\s*${key}\\s*=\\s*\\S`, 'm').test(text)

/**
 * Prépare les cartes dédiées du jeu avant son lancement : crée les deux dossiers de carte, y reprend les sauvegardes que le jeu avait dans les cartes partagées, et
 * déclare ces cartes dans les réglages par jeu (`gamesettings/<SERIE>_<CRC>.ini`, complétés sans toucher à ce que l'utilisateur y a déjà réglé, carte comprise).
 * Sans CRC (disque illisible), un fichier de réglages à nous est donné par `-gamecfg`. `key` : numéro de série connu ; sans lui, la carte porte l'identifiant de l'entrée.
 */
export async function preparePcsx2Cards(dir: string, game: Ps2Game | null, key: string | null, entryId: number): Promise<CardSetup> {
  const memcards = join(dir, 'memcards')
  const serial = key ?? game?.serial ?? null
  let names = pcsx2CardNames(serial ?? `g${entryId}`)
  // Carte créée avant que le numéro de série soit connu (jeu illisible au premier lancement) : on la rebaptise plutôt que de la perdre.
  if (serial) {
    const old = pcsx2CardNames(`g${entryId}`)
    for (let i = 0; i < 2; i++) if (existsSync(join(memcards, old[i])) && !existsSync(join(memcards, names[i]))) await rename(join(memcards, old[i]), join(memcards, names[i])).catch(() => {})
  }
  await mkdir(memcards, { recursive: true })
  const slot1 = await createFolderCard(memcards, names[0])
  await createFolderCard(memcards, names[1])
  let migrated = 0
  if (serial) migrated = await migrateSharedSaves(memcards, serial, slot1, 'Mcd001.ps2').catch(() => 0)
  const patch = { MemoryCards: { Slot1_Filename: names[0], Slot2_Filename: names[1] } }
  if (game) {
    const file = join(dir, 'gamesettings', `${game.serial}_${game.crc}.ini`)
    const text = existsSync(file) ? await readFile(file, 'utf8') : ''
    const missing = Object.fromEntries(Object.entries(patch.MemoryCards).filter(([k]) => !hasKey(text, k)))
    if (Object.keys(missing).length) {
      await mkdir(join(dir, 'gamesettings'), { recursive: true })
      await writeFile(file, patchIni(text, { MemoryCards: missing }))
    }
    return { args: [], names, migrated }
  }
  const file = join(dir, 'gamesettings', `romvault-${names[0]}.ini`)
  await mkdir(join(dir, 'gamesettings'), { recursive: true })
  await writeFile(file, patchIni('', patch))
  return { args: ['-gamecfg', file], names, migrated }
}

/** Numéro de série appris du journal de PCSX2 (« Serial: SLES-52541 ») : dernier lancement. */
export async function pcsx2SerialFromLog(dir: string): Promise<string | null> {
  const log = await readFile(join(dir, 'logs', 'emulog.txt'), 'utf8').catch(() => '')
  const m = [...log.matchAll(/Serial:\s*([A-Z]{4}-\d{5})/g)].pop()
  return m ? m[1] : null
}

export async function folderCardExists(dir: string, name: string): Promise<boolean> {
  return (await stat(join(dir, 'memcards', name)).catch(() => null))?.isDirectory() ?? false
}
