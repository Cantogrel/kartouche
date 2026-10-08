import type { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { ROM_EXTENSIONS, type ImportItem, type ImportResult, type LibraryProgress, type MatchKind } from '@shared/library'
import { archiveVolume, cleanupWorkDir, newWorkDir, unpackArchive } from './archive'
import { isNsz, unpackNsz } from './nsz'
import { extractZipEntries, hashAndCopyFile, hashFile, readZip, readZipEntryHead, readZipEntryText } from './hash'
import { identify, type Identified } from './identify'
import { baseKeyOfFile } from './content/baseKey'
import { CONTENT_EXTENSIONS, filenameInfo, probeFile, probeWiiUFolder } from './content/probe'
import { isTitleContainer, NOT_A_TITLE, parsePfs0 } from './content/switch'
import { adoptOrphans, attachContent, contentLog, findParent, type ContentEnv } from './content/store'
import type { ContentInfo } from './content/types'
import { getRow } from '../emulators/emulatorStore'
import { installerFor, installPendingContent } from '../emulators/content'

export interface ImportOptions {
  /** Copier dans <roms>/<console>/ (sinon le fichier reste où il est). */
  copy: boolean
  deleteSource: boolean
  romsDir: string
  /**
   * Rattachement déjà connu avec certitude (téléchargement vérifié par downloads/install.ts contre le hash déclaré
   * d'une liste de sources) : remplace identify() au lieu de deviner par hash catalogue/nom — utile pour une ROM
   * volontairement modifiée (patch, traduction) dont le hash ne correspondra jamais au DAT officiel. Ne s'applique
   * qu'au seul fichier importé par cet appel (jamais utilisé avec plusieurs chemins).
   */
  expected?: { gameId: number; console: string; title: string; match: MatchKind }
  /**
   * Le fichier importé est un temporaire appartenant à l'appelant (ROM extraite d'une archive .7z/.rar par
   * downloads/install.ts) : déplacé à sa place finale au lieu d'être copié, jamais supprimé ici — l'appelant nettoie.
   * Ne s'applique qu'au seul fichier importé par cet appel.
   */
  owned?: boolean
  /** Dossier des journaux : les mises à jour/DLC sans jeu parent y laissent une trace (`content.log`). */
  logDir?: string
  /**
   * Import depuis la fiche d'un jeu : seuls sont acceptés les mises à jour et DLC DE CE JEU (identifiant natif du parent = celui du jeu). Tout le reste — un jeu,
   * un contenu d'un autre jeu, un fichier illisible — est refusé avec la raison, sans rien ranger ni créer d'entrée.
   */
  forGame?: { id: number }
}

/** `prod.keys` de l'Eden installé (déchiffre les NCA de métadonnées d'un NSP) ; undefined si Eden n'est pas installé. */
const edenKeysFile = (db: DatabaseSync): string | undefined => { const r = getRow(db, 'eden'); return r ? join(r.dir, 'user', 'keys', 'prod.keys') : undefined }

const extOf = (p: string): string => extname(p).slice(1).toLowerCase()
const isRom = (p: string): boolean => extOf(p) in ROM_EXTENSIONS || extOf(p) === 'zip' || isNsz(p) || archiveVolume(p) !== null || CONTENT_EXTENSIONS.includes(extOf(p))
const stemOf = (p: string): string => basename(p, extname(p))

const NOT_CONTENT = 'pas une mise à jour ni un contenu additionnel'

interface ContentFolder { path: string; info: ContentInfo }

/**
 * Parcourt un dossier. Un dossier de mise à jour/DLC Wii U (`title.tmd`, ou `meta/meta.xml`) est une unité à part entière : il est signalé dans `folders`
 * et on n'y descend pas (ses fichiers `.app` ne sont pas des ROM).
 */
async function walk(dir: string, out: string[], folders: ContentFolder[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const info = await probeWiiUFolder(p).catch(() => null)
      if (info) folders.push({ path: p, info })
      else await walk(p, out, folders)
    } else if (e.isFile()) out.push(p)
  }
}

/** Fichiers référencés par une feuille .cue (pistes .bin), résolus par rapport à son dossier. */
export async function cueFiles(cue: string): Promise<string[]> {
  const text = await readFile(cue, 'latin1')
  const files = [...text.matchAll(/^\s*FILE\s+"([^"]+)"/gim)].map((m) => resolve(dirname(cue), m[1]))
  return files.filter((f) => existsSync(f))
}

/** Nom libre dans le dossier de destination (« Jeu (2).iso » si « Jeu.iso » existe déjà). */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const ext = extname(name), stem = basename(name, ext)
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`
}

export interface Prepared {
  crc?: string
  sha1?: string
  size: number
  name: string
  ext: string
  /** Zip disque multi-fichiers (.cue + pistes) : entrées à extraire, feuille .cue en tête. */
  zipEntries?: string[]
  /** Zip d'une seule ROM : nom de l'entrée (voir `UNZIP_ON_IMPORT`). */
  zipEntry?: string
}

/**
 * Consoles dont l'émulateur (Dolphin) ne lit pas les .zip : le jeu y est décompressé UNE fois, à l'import, et seul le fichier décompressé est gardé en bibliothèque. Sinon chaque lancement
 * réextrayait plusieurs Go dans le cache (9 s d'attente pour Super Mario Galaxy). Les formats déjà compressés (.rvz, .wia, .gcz) restent tels quels une fois sortis du zip.
 */
export const UNZIP_ON_IMPORT: ReadonlySet<string> = new Set(['wii', 'gc'])

/**
 * Extrait l'unique ROM d'un zip vers `dest` en vérifiant son empreinte (CRC et taille de l'entrée) avant de la mettre en place : un fichier incomplet ou corrompu n'existe jamais sous son
 * vrai nom, et l'archive n'est supprimée par l'appelant qu'après ce contrôle.
 */
export async function unzipVerified(zip: string, entry: string, dest: string, expect: { crc?: string; size: number }, onBytes?: (bytes: number) => void): Promise<boolean> {
  const part = `${dest}.part`
  try {
    if (!(await extractZipEntries(zip, [{ entry, dest: part }]))) return false
    const h = await hashFile(part, onBytes)
    if (h.size !== expect.size || (expect.crc && h.crc.toLowerCase() !== expect.crc.toLowerCase())) return false
    await rename(part, dest)
    return true
  } catch { return false } finally { await rm(part, { force: true }).catch(() => undefined) }
}

/** Empreinte (+ détection zip/.cue) d'un fichier, sans effet de bord — réutilisé par downloads/install.ts pour vérifier un téléchargement avant de l'installer. */
export async function prepare(file: string, extra: string[], onBytes?: (bytes: number) => void): Promise<Prepared | string> {
  const ext = extOf(file)
  if (ext === 'zip') {
    const all = await readZip(file)
    if (!all) return 'archive illisible'
    // Paquet PS Vita (contenu à la racine du zip : eboot.bin + sce_sys/, comme un vrai .vpk qui n'est qu'un zip renommé) :
    // vérifié AVANT le cas single-ROM ci-dessous, sinon son eboot.bin (extension .bin) serait confondu avec un disque
    // PS1/PS2 générique. Le fichier entier EST la ROM, jamais extrait — Vita3K sait l'installer directement, .zip ou .vpk indifféremment.
    if (all.some((z) => /(^|\/)eboot\.bin$/i.test(z.name)) && all.some((z) => /^sce_sys\//i.test(z.name))) {
      const h = await hashFile(file, onBytes)
      return { crc: h.crc, sha1: h.sha1, size: (await stat(file)).size, name: stemOf(file), ext: 'vpk' }
    }
    const roms = all.filter((z) => extOf(z.name) in ROM_EXTENSIONS)
    if (roms.length === 1) {
      const z = roms[0]
      return { crc: z.crc, size: z.size, name: stemOf(z.name), ext: extOf(z.name), zipEntry: z.name }
    }
    // Disque .cue + pistes dans un zip : reconnu seulement si une unique feuille .cue référence exactement les autres entrées de ROM.
    const cues = roms.filter((z) => extOf(z.name) === 'cue')
    if (cues.length === 1) {
      const cue = cues[0]
      const text = await readZipEntryText(file, cue.name)
      const refs = text ? [...text.matchAll(/^\s*FILE\s+"([^"]+)"/gim)].map((m) => basename(m[1]).toLowerCase()) : null
      const tracks = refs?.map((r) => roms.find((z) => basename(z.name).toLowerCase() === r)).filter((z): z is typeof roms[number] => !!z)
      if (refs && tracks && tracks.length === refs.length && tracks.length + 1 === roms.length) {
        const t = tracks[0]
        return { crc: t.crc, size: t.size, name: stemOf(cue.name), ext: 'cue', zipEntries: [cue.name, ...tracks.map((tr) => tr.name)] }
      }
    }
    return 'archive : un seul fichier de ROM attendu (ou un .cue avec ses pistes)'
  }
  // Disque .cue : l'empreinte de référence est celle de la première piste.
  const target = ext === 'cue' && extra[0] ? extra[0] : file
  const h = await hashFile(target, onBytes)
  return { crc: h.crc, sha1: h.sha1, size: ext === 'cue' ? h.size : (await stat(file)).size, name: stemOf(file), ext }
}

/**
 * Importe fichiers et dossiers : empreinte, identification contre le catalogue, copie dans le dossier de la console,
 * suppression éventuelle de l'original, enregistrement en bibliothèque. Un fichier en échec n'arrête pas les suivants.
 *
 * Mises à jour et DLC (Switch, 3DS, PS3, Wii U, Vita — voir library/content/) : tout le lot est ANALYSÉ d'abord (identifiant natif lu dans le fichier),
 * les jeux principaux sont importés, puis chaque mise à jour/DLC est rattachée à son jeu parent (déjà présent, ou importé dans ce lot) et installée dans
 * l'émulateur par le mécanisme de celui-ci. Un contenu n'est jamais une ligne de la bibliothèque : sans jeu parent il est mis en attente (`orphan`), puis rattaché
 * dès que le jeu arrive. L'ordre des fichiers du lot n'a aucune importance.
 */
export async function importPaths(db: DatabaseSync, paths: string[], opt: ImportOptions, onProgress: (p: LibraryProgress) => void = () => undefined): Promise<ImportResult> {
  const items: ImportItem[] = []
  let ignored = 0
  const files: string[] = []
  const folders: ContentFolder[] = []
  /** Fichiers trouvés en parcourant un dossier (par opposition à ceux choisis un à un) : un `.pkg` hors périmètre y est ignoré sans bruit. */
  const walked = new Set<string>()
  for (const p of paths) {
    try {
      if ((await stat(p)).isDirectory()) {
        const own = await probeWiiUFolder(p).catch(() => null)
        if (own) { folders.push({ path: p, info: own }); continue }
        const found: string[] = []
        await walk(p, found, folders)
        for (const f of found) { if (isRom(f)) { files.push(f); walked.add(f) } else ignored++ }
      } else if (isRom(p)) files.push(p)
      else items.push({ file: p, status: 'error', error: 'extension non prise en charge' })
    } catch (e) { items.push({ file: p, status: 'error', error: (e as Error).message }) }
  }

  // Les pistes d'une feuille .cue voyagent avec elle : elles ne sont pas importées seules.
  const extras = new Map<string, string[]>()
  const consumed = new Set<string>()
  for (const f of files) if (extOf(f) === 'cue') {
    const refs = await cueFiles(f).catch(() => [])
    extras.set(f, refs)
    refs.forEach((r) => consumed.add(resolve(r).toLowerCase()))
  }
  // Volumes d'archive (game.part2.rar, game.7z.002…) : jamais importés seuls — ils voyagent avec le premier volume.
  for (const f of files) {
    const v = archiveVolume(f)
    if (!v || v.isFirst) continue
    consumed.add(resolve(f).toLowerCase())
    if (!files.some((x) => resolve(x).toLowerCase() === resolve(v.first).toLowerCase())) {
      items.push({ file: f, status: 'error', error: existsSync(v.first) ? `volume d’archive : importer le premier volume (${basename(v.first)})` : `archive en plusieurs volumes : premier volume manquant (${basename(v.first)})` })
    }
  }
  const queue = files.filter((f) => !consumed.has(resolve(f).toLowerCase()))

  // Phase 1 — analyse de TOUT le lot avant la moindre décision : l'identifiant natif de chaque fichier (jeu, mise à jour, DLC) est lu dans le fichier
  // lui-même (jamais deviné par son nom quand le format le porte). Les archives .7z/.rar ne sont lisibles qu'une fois extraites : voir plus bas.
  const ctx = { switchKeysFile: edenKeysFile(db), cemuDir: getRow(db, 'cemu')?.dir }
  const analysed = new Map<string, ContentInfo>()
  for (const f of queue) {
    if (archiveVolume(f)) continue
    const info = await probeFile(f, ctx).catch((e: Error) => { void contentLog(opt.logDir, `analyse impossible ${f} : ${e.message}`); return null })
    if (info) analysed.set(f, info)
  }

  // Phase 2 — tri : mises à jour/DLC (et dossiers Wii U) sont mis de côté pour après les jeux principaux ; un contenu non fiable ou un jeu `.pkg` est refusé.
  const contents: { entry: string; info: ContentInfo }[] = folders.map((f) => ({ entry: f.path, info: f.info }))
  const romQueue: string[] = []
  for (const f of queue) {
    const info = analysed.get(f)
    if (info && info.kind === 'unknown' && extOf(f) === 'pkg' && walked.has(f)) ignored++
    else if (info && info.kind !== 'base') contents.push({ entry: f, info })
    else if (extOf(f) === 'pkg') {
      // Un .pkg qui n'est pas un contenu rattachable (jeu PSN complet, autre plateforme, illisible) n'est pas une ROM : refusé s'il a été choisi explicitement, ignoré dans un dossier.
      if (walked.has(f)) ignored++
      else items.push({ file: f, status: 'error', error: info ? 'jeu PSN (.pkg) : installation du jeu non prise en charge' : 'paquet illisible ou non pris en charge' })
    }
    else if (opt.forGame && !archiveVolume(f) && !isNsz(f)) items.push({ file: f, status: 'error', error: NOT_CONTENT })
    else romQueue.push(f)
  }
  const affected = new Set<number>()
  const contentEnv = (consoleId: string, owned: boolean): ContentEnv => ({ ...ctx, romsDir: opt.romsDir, copy: opt.copy, deleteSource: opt.deleteSource, managed: installerFor(consoleId)?.managed === true, owned, logDir: opt.logDir })
  /** Rattache (ou met en attente) un contenu identifié ; un contenu non fiable est refusé sans toucher au fichier. */
  const handleContent = async (entry: string, file: string, info: ContentInfo, owned: boolean): Promise<ImportItem> => {
    if (info.kind === 'unknown') {
      await contentLog(opt.logDir, `contenu non fiable ${entry} : ${info.reason ?? 'identification impossible'}`)
      return { file: entry, status: 'error', error: info.reason ?? 'contenu non identifiable de façon fiable' }
    }
    if (opt.forGame) {
      const parent = info.baseKey ? await findParent(db, info.console, info.baseKey, ctx) : null
      if (!parent || parent.id !== opt.forGame.id) {
        await contentLog(opt.logDir, `contenu refusé pour le jeu ${opt.forGame.id} (parent ${info.baseKey || 'inconnu'}) : ${entry}`)
        return { file: entry, status: 'error', console: info.console, title: info.label, error: parent ? `appartient à un autre jeu (${parent.title})` : 'ne correspond pas à ce jeu (jeu parent différent ou illisible)' }
      }
    }
    try {
      const r = await attachContent(db, info, file, contentEnv(info.console, owned))
      if (r.libraryId !== undefined) affected.add(r.libraryId)
      return { ...r.item, file: entry }
    } catch (e) { return { file: entry, status: 'error', error: (e as Error).message } }
  }
  /**
   * Mémorise l'identifiant natif d'un jeu de base (clé de ses futures mises à jour/DLC) puis lui rattache ceux qui l'attendaient. Seulement pour les consoles qui
   * ont cette notion ; un format qui ne permet pas de lire l'identifiant laisse le jeu sans clé (jamais de devinette par le nom).
   */
  const learn = async (libraryId: number, consoleId: string, path: string, known: string | null): Promise<void> => {
    if (!installerFor(consoleId)) return
    const key = known ?? (await baseKeyOfFile(consoleId, path, ctx).catch(() => null))
    if (!key) return
    db.prepare('UPDATE library SET title_id = COALESCE(title_id, ?) WHERE id = ?').run(key, libraryId)
    if (adoptOrphans(db, libraryId, consoleId, key) > 0) affected.add(libraryId)
  }
  const total = romQueue.length + contents.length

  const sameRom = db.prepare('SELECT id, path FROM library WHERE path = ? OR (console = ? AND crc = ? AND size = ?)')
  const byGame = db.prepare('SELECT id, path FROM library WHERE game_id = ? AND console = ?')
  // title_id : gardé seulement pour un jeu de base (voir switchContent.ts) ; COALESCE au relink pour ne jamais effacer une valeur déjà connue.
  const relink = db.prepare('UPDATE library SET path = ?, size = ?, crc = ?, sha1 = ?, match = ?, missing = 0, title_id = COALESCE(title_id, ?) WHERE id = ?')
  const insert = db.prepare('INSERT INTO library (game_id, console, title, path, size, crc, sha1, match, title_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  // Fichiers temporaires du chemin rapide ci-dessous (empreinte + copie en une passe) : nettoyé même après un crash précédent.
  const tmpDir = join(opt.romsDir, '.import-tmp')
  let done = 0
  let lastReport = 0
  for (const entry of romQueue) {
    // Archive .7z/.rar : extraite d'abord dans un dossier temporaire (voir archive.ts) ; ce qui en sort (la ROM, ou un .zip
    // reconstitué pour un jeu à plusieurs fichiers) suit ensuite exactement le même chemin qu'un fichier importé tel quel.
    let file = entry
    let workDir: string | null = null
    let volumes: string[] = []
    let owned = opt.owned === true
    if (archiveVolume(entry) || isNsz(entry)) {
      onProgress({ done, total, current: basename(entry), bytesDone: 0 })
      workDir = newWorkDir(opt.romsDir, String(done))
      // .nsz (NSP compressé) : décompressé en .nsp, qui suit ensuite le chemin d'un .nsp ordinaire (mise à jour/DLC reconnus dans le fichier décompressé).
      const unpacked = await (isNsz(entry) ? unpackNsz(entry, workDir, (d, t) => { const now = Date.now(); if (now - lastReport >= 150 || d === t) { lastReport = now; onProgress({ done, total, current: basename(entry), bytesDone: d, bytesTotal: t }) } }) : unpackArchive(entry, workDir)).catch((e: Error) => e.message)
      if (typeof unpacked === 'string') {
        items.push({ file: entry, status: 'error', error: unpacked })
        await cleanupWorkDir(workDir)
        done++
        continue
      }
      file = unpacked.file
      volumes = unpacked.volumes
      owned = true
      // Ce qui sort de l'archive peut être une mise à jour/DLC : lisible seulement maintenant. Déplacé hors du dossier de travail, rattaché ou mis en attente.
      const inner = await probeFile(file, ctx).catch(() => null)
      if (inner) analysed.set(file, inner)
      if (inner && inner.kind !== 'base') {
        const item = await handleContent(entry, file, inner, true)
        items.push(item)
        if (opt.deleteSource && (item.status === 'attached' || item.status === 'orphan')) for (const v of volumes) await rm(v, { force: true }).catch(() => undefined)
        await cleanupWorkDir(workDir)
        done++
        continue
      }
    }
    if (opt.forGame) {
      // Archive qui ne contient ni mise à jour ni DLC (un jeu, ou rien de lisible) : refusée.
      items.push({ file: entry, status: 'error', error: NOT_CONTENT })
      if (workDir) await cleanupWorkDir(workDir)
      done++
      continue
    }
    const ext = extOf(file)
    const refs = extras.get(file) ?? []
    const inRoms = resolve(file).toLowerCase().startsWith(resolve(opt.romsDir).toLowerCase())
    // Chemin rapide : fichier seul (pas de zip ni de .cue multi-pistes) copié vers le dossier de ROMs. On lit la source
    // une seule fois (empreinte + copie simultanées, voir `hashAndCopyFile`) au lieu de deux (empreinte puis copie) :
    // ~1,5x moins d'E/S sur une ROM de plusieurs Go (Switch, PS2…), et le renommage final est instantané (même volume).
    const fuse = ext !== 'zip' && ext !== 'cue' && opt.copy && !inRoms && !owned
    const bytesTotal = ext === 'zip' ? undefined : (await stat(file).catch(() => null))?.size
    const reportBytes = (bytesDone: number): void => {
      const now = Date.now()
      if (now - lastReport < 150 && bytesDone !== bytesTotal) return
      lastReport = now
      onProgress({ done, total, current: basename(file), bytesDone, bytesTotal })
    }
    onProgress({ done, total, current: basename(file), bytesDone: 0, bytesTotal })
    let tempPath: string | null = null
    try {
      let prep: Prepared | string
      if (fuse) {
        await mkdir(tmpDir, { recursive: true })
        tempPath = join(tmpDir, `${process.pid}-${Date.now()}-${basename(file)}`)
        const h = await hashAndCopyFile(file, tempPath, reportBytes)
        prep = { crc: h.crc, sha1: h.sha1, size: h.size, name: stemOf(file), ext }
      } else {
        prep = await prepare(file, refs, reportBytes)
      }
      if (typeof prep === 'string') { items.push({ file: entry, status: 'error', error: prep }); continue }
      // NSP/XCI dans un .zip : le conteneur n'est pas lisible sans extraction, seul le nom permet de reconnaître une mise à jour/un DLC — refusés plutôt que d'en faire un jeu.
      if (ext === 'zip' && prep.ext === 'nsp') {
        // Mais l'en-tête du NSP est lisible dans l'archive : un « .nsp » sans NCA (module système comme emuiibo, ExeFS) n'est pas un titre Switch.
        const inner = (await readZip(file).catch(() => null))?.find((z) => extOf(z.name) === 'nsp')
        const entries = inner ? parsePfs0((await readZipEntryHead(file, inner.name, 1 << 20).catch(() => null)) ?? Buffer.alloc(0)) : null
        if (entries && !isTitleContainer(entries)) { items.push({ file: entry, status: 'error', error: NOT_A_TITLE }); continue }
      }
      if (ext === 'zip' && (prep.ext === 'nsp' || prep.ext === 'xci')) {
        const named = filenameInfo(`${prep.name}.${prep.ext}`)
        if (named && named.kind !== 'base') {
          items.push({ file: entry, status: 'error', error: `${named.kind === 'update' ? 'mise à jour' : 'DLC'} Switch dans une archive .zip : extraire le fichier avant de l’importer` })
          continue
        }
      }
      // Jeu principal : son identifiant natif (lu dans le conteneur) rattachera plus tard ses mises à jour et ses DLC.
      const baseInfo = analysed.get(file) ?? analysed.get(entry)
      const titleId = baseInfo?.kind === 'base' && baseInfo.baseKey ? baseInfo.baseKey : null
      const id: Identified = opt.expected
        ? { gameId: opt.expected.gameId, console: opt.expected.console, title: opt.expected.title, match: opt.expected.match, candidates: [opt.expected.console] }
        : identify(db, prep)
      const cons = id.console ?? (id.candidates.length === 1 ? id.candidates[0] : null)
      if (!cons) { items.push({ file: entry, status: 'ambiguous', error: id.candidates.join(', ') }); continue }
      const title = id.title ?? prep.name
      const same = sameRom.all(file, cons, prep.crc ?? '', prep.size) as { id: number; path: string }[]
      const present = same.find((r) => existsSync(r.path))
      if (present) {
        await learn(present.id, cons, present.path, titleId)
        items.push({ file: entry, status: 'duplicate', console: cons, title, match: id.match })
        continue
      }
      // Entrée du même jeu dont le fichier a disparu (ou jamais existé : jeu ajouté depuis le catalogue) : la ROM s'y rattache.
      const target = same[0] ?? (id.gameId !== null ? (byGame.all(id.gameId, cons) as { id: number; path: string }[]).find((r) => !existsSync(r.path)) : undefined)

      let dest = file
      if (prep.zipEntries) {
        // Un .cue dans un zip ne peut pas rester tel quel (ses pistes doivent exister à côté sur disque) : toujours extrait.
        const [cueEntry, ...trackEntries] = prep.zipEntries
        const dir = join(opt.romsDir, cons)
        await mkdir(dir, { recursive: true })
        dest = join(dir, freeName(dir, basename(cueEntry)))
        const mapping = [{ entry: cueEntry, dest }, ...trackEntries.map((t) => ({ entry: t, dest: join(dir, basename(t)) }))]
        if (!(await extractZipEntries(file, mapping))) { await rm(dest, { force: true }); throw new Error('extraction de l’archive échouée') }
        if (opt.deleteSource) await rm(file, { force: true })
      } else if (ext === 'zip' && prep.zipEntry && UNZIP_ON_IMPORT.has(cons)) {
        // Wii/GameCube : décompressé à l'import, seul le jeu décompressé est gardé. La copie dans le dossier de ROMs de la bibliothèque (ou le zip temporaire sorti d'une archive) est supprimée une fois
        // le fichier vérifié ; l'original choisi par l'utilisateur ne l'est que s'il l'a demandé (deleteSource).
        const dir = join(opt.romsDir, cons)
        await mkdir(dir, { recursive: true })
        dest = join(dir, freeName(dir, basename(prep.zipEntry)))
        if (!(await unzipVerified(file, prep.zipEntry, dest, { crc: prep.crc, size: prep.size }, reportBytes))) throw new Error('extraction de l’archive échouée')
        if (opt.deleteSource || inRoms) await rm(file, { force: true })
      } else if (tempPath) {
        // Déjà empreinté ET copié dans le fichier temporaire ci-dessus : il ne reste qu'à le renommer à sa place finale.
        const dir = join(opt.romsDir, cons)
        await mkdir(dir, { recursive: true })
        dest = join(dir, freeName(dir, basename(file)))
        await rename(tempPath, dest)
        tempPath = null
        if (opt.deleteSource) await rm(file, { force: true })
      } else if (owned) {
        // Temporaire extrait d'une archive : déplacé à sa place (même volume que le dossier de ROMs, donc instantané).
        const dir = join(opt.romsDir, cons)
        await mkdir(dir, { recursive: true })
        dest = join(dir, freeName(dir, basename(file)))
        try { await rename(file, dest) } catch {
          await copyFile(file, dest)
          if ((await stat(dest)).size !== (await stat(file)).size) { await rm(dest, { force: true }); throw new Error('copie incomplète') }
          await rm(file, { force: true })
        }
      } else if (opt.copy && !inRoms) {
        const dir = join(opt.romsDir, cons)
        await mkdir(dir, { recursive: true })
        const name = freeName(dir, basename(file))
        dest = join(dir, name)
        await copyFile(file, dest)
        // Les pistes d'un .cue gardent leur nom : la feuille les référence.
        for (const r of refs) await copyFile(r, join(dir, basename(r))).catch(() => undefined)
        if ((await stat(dest)).size !== (await stat(file)).size) { await rm(dest, { force: true }); throw new Error('copie incomplète') }
        if (opt.deleteSource) for (const f of [file, ...refs]) await rm(f, { force: true })
      }
      let libraryId: number
      if (target) { relink.run(dest, prep.size, prep.crc ?? null, prep.sha1 ?? null, id.match, titleId, target.id); libraryId = target.id }
      else libraryId = Number(insert.run(id.gameId, cons, title, dest, prep.size, prep.crc ?? null, prep.sha1 ?? null, id.match, titleId, Date.now()).lastInsertRowid)
      await learn(libraryId, cons, dest, titleId)
      if (opt.deleteSource) for (const v of volumes) await rm(v, { force: true }).catch(() => undefined)
      items.push({ file: entry, status: 'added', console: cons, title, match: id.match })
    } catch (e) {
      items.push({ file: entry, status: 'error', error: (e as Error).message })
    } finally {
      if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined)
      if (workDir) await cleanupWorkDir(workDir)
    }
    done++
  }
  // Phase 3 — mises à jour et DLC : tous les jeux du lot sont maintenant en bibliothèque, quel que soit l'ordre des fichiers.
  for (const { entry, info } of contents) {
    onProgress({ done, total, current: basename(entry) })
    items.push(await handleContent(entry, entry, info, false))
    done++
  }
  // Phase 4 — installation dans l'émulateur, par le mécanisme propre à chacun (voir emulators/content/) ; ce qui n'a pas pu l'être reste en attente et sera retenté au lancement.
  for (const libraryId of affected) await installPendingContent(db, libraryId, opt.romsDir, 'import').catch((e: Error) => contentLog(opt.logDir, `installation (jeu ${libraryId}) : ${e.message}`))
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  onProgress({ done, total, current: '' })
  return { items, ignored }
}
