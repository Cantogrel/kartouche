import type { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { ROM_EXTENSIONS, type ImportItem, type ImportResult, type LibraryProgress, type MatchKind } from '@shared/library'
import { extractZipEntries, hashAndCopyFile, hashFile, readZip, readZipEntryText } from './hash'
import { identify, type Identified } from './identify'
import { switchContentFromFilename } from './switchContent'

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
}

const extOf = (p: string): string => extname(p).slice(1).toLowerCase()
const isRom = (p: string): boolean => extOf(p) in ROM_EXTENSIONS || extOf(p) === 'zip'
const stemOf = (p: string): string => basename(p, extname(p))

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (e.isFile()) out.push(p)
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
      return { crc: z.crc, size: z.size, name: stemOf(z.name), ext: extOf(z.name) }
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

/** Messages précis affichés quand un import de mise à jour/DLC Switch est refusé (voir la note sur `importPaths`). */
const SWITCH_CONTENT_MESSAGE: Record<'update' | 'dlc', string> = {
  update: "mise à jour Switch non prise en charge : à installer manuellement dans l'émulateur (File > Install Files to NAND)",
  dlc: "DLC Switch non pris en charge : à installer manuellement dans l'émulateur (File > Install Files to NAND)"
}

/**
 * Importe fichiers et dossiers : empreinte, identification contre le catalogue, copie dans le dossier de la console,
 * suppression éventuelle de l'original, enregistrement en bibliothèque. Un fichier en échec n'arrête pas les suivants.
 * Une mise à jour/un DLC Switch (repéré par Title ID ou par mot-clé, voir switchContent.ts) n'est jamais importé :
 * Eden (comme les autres émulateurs basés sur Yuzu) n'a pas de commande pour l'installer, seulement son propre menu
 * File > Install Files to NAND ; le fichier reste donc tel quel et l'erreur le dit clairement.
 */
export async function importPaths(db: DatabaseSync, paths: string[], opt: ImportOptions, onProgress: (p: LibraryProgress) => void = () => undefined): Promise<ImportResult> {
  const items: ImportItem[] = []
  let ignored = 0
  const files: string[] = []
  for (const p of paths) {
    try {
      if ((await stat(p)).isDirectory()) {
        const found: string[] = []
        await walk(p, found)
        for (const f of found) { if (isRom(f)) files.push(f); else ignored++ }
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
  const queue = files.filter((f) => !consumed.has(resolve(f).toLowerCase()))

  const sameRom = db.prepare('SELECT id, path FROM library WHERE path = ? OR (console = ? AND crc = ? AND size = ?)')
  const byGame = db.prepare('SELECT id, path FROM library WHERE game_id = ? AND console = ?')
  // title_id : gardé seulement pour un jeu de base (voir switchContent.ts) ; COALESCE au relink pour ne jamais effacer une valeur déjà connue.
  const relink = db.prepare('UPDATE library SET path = ?, size = ?, crc = ?, sha1 = ?, match = ?, missing = 0, title_id = COALESCE(title_id, ?) WHERE id = ?')
  const insert = db.prepare('INSERT INTO library (game_id, console, title, path, size, crc, sha1, match, title_id, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  // Fichiers temporaires du chemin rapide ci-dessous (empreinte + copie en une passe) : nettoyé même après un crash précédent.
  const tmpDir = join(opt.romsDir, '.import-tmp')
  let done = 0
  let lastReport = 0
  for (const file of queue) {
    const ext = extOf(file)
    const refs = extras.get(file) ?? []
    const inRoms = resolve(file).toLowerCase().startsWith(resolve(opt.romsDir).toLowerCase())
    // Chemin rapide : fichier seul (pas de zip ni de .cue multi-pistes) copié vers le dossier de ROMs. On lit la source
    // une seule fois (empreinte + copie simultanées, voir `hashAndCopyFile`) au lieu de deux (empreinte puis copie) :
    // ~1,5x moins d'E/S sur une ROM de plusieurs Go (Switch, PS2…), et le renommage final est instantané (même volume).
    const fuse = ext !== 'zip' && ext !== 'cue' && opt.copy && !inRoms
    const bytesTotal = ext === 'zip' ? undefined : (await stat(file).catch(() => null))?.size
    const reportBytes = (bytesDone: number): void => {
      const now = Date.now()
      if (now - lastReport < 150 && bytesDone !== bytesTotal) return
      lastReport = now
      onProgress({ done, total: queue.length, current: basename(file), bytesDone, bytesTotal })
    }
    onProgress({ done, total: queue.length, current: basename(file), bytesDone: 0, bytesTotal })
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
      if (typeof prep === 'string') { items.push({ file, status: 'error', error: prep }); continue }
      // Mise à jour/DLC Switch (Title ID entre crochets/parenthèses, ou mot-clé à défaut) : jamais importé, voir la note ci-dessus.
      const content = (ROM_EXTENSIONS[ext] ?? []).includes('switch') ? switchContentFromFilename(prep.name) : null
      if (content && content.kind !== 'base') {
        items.push({ file, status: 'error', error: SWITCH_CONTENT_MESSAGE[content.kind] })
        continue
      }
      const titleId = content?.kind === 'base' ? content.titleId : null
      const id: Identified = opt.expected
        ? { gameId: opt.expected.gameId, console: opt.expected.console, title: opt.expected.title, match: opt.expected.match, candidates: [opt.expected.console] }
        : identify(db, prep)
      const cons = id.console ?? (id.candidates.length === 1 ? id.candidates[0] : null)
      if (!cons) { items.push({ file, status: 'ambiguous', error: id.candidates.join(', ') }); continue }
      const title = id.title ?? prep.name
      const same = sameRom.all(file, cons, prep.crc ?? '', prep.size) as { id: number; path: string }[]
      if (same.some((r) => existsSync(r.path))) { items.push({ file, status: 'duplicate', console: cons, title, match: id.match }); continue }
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
      } else if (tempPath) {
        // Déjà empreinté ET copié dans le fichier temporaire ci-dessus : il ne reste qu'à le renommer à sa place finale.
        const dir = join(opt.romsDir, cons)
        await mkdir(dir, { recursive: true })
        dest = join(dir, freeName(dir, basename(file)))
        await rename(tempPath, dest)
        tempPath = null
        if (opt.deleteSource) await rm(file, { force: true })
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
      if (target) relink.run(dest, prep.size, prep.crc ?? null, prep.sha1 ?? null, id.match, titleId, target.id)
      else insert.run(id.gameId, cons, title, dest, prep.size, prep.crc ?? null, prep.sha1 ?? null, id.match, titleId, Date.now())
      items.push({ file, status: 'added', console: cons, title, match: id.match })
    } catch (e) {
      items.push({ file, status: 'error', error: (e as Error).message })
    } finally {
      if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined)
    }
    done++
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  onProgress({ done, total: queue.length, current: '' })
  return { items, ignored }
}
