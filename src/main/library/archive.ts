import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, parse, relative, resolve, sep } from 'node:path'
import { ROM_EXTENSIONS } from '@shared/library'

/**
 * Archives .7z et .rar (le .zip garde son lecteur maison, voir hash.ts) : extraites par 7-Zip compilé en WebAssembly
 * (paquet `7z-wasm`, LGPL-2.1+ avec restriction unRAR — le .wasm reste un fichier séparé et remplaçable, jamais
 * fusionné dans le code de RomVault ; la restriction unRAR n'interdit que de recréer la compression RAR, on ne fait
 * qu'extraire). Aucun exécutable externe (ni 7z.exe ni WinRAR) : le moteur tourne dans un processus enfant lancé avec
 * le runtime déjà embarqué (Electron en mode « node »), pour ne pas geler l'interface pendant l'extraction d'une ISO de
 * plusieurs Go, et pour qu'un plantage ne tombe jamais le processus principal.
 */

export type ArchiveKind = '7z' | 'rar'
export interface ArchiveVolume {
  kind: ArchiveKind
  /** Premier volume (celui qu'on ouvre) ; égal au fichier lui-même pour une archive en un seul morceau. */
  first: string
  isFirst: boolean
}

const RAR_PART = /^(.*)\.part(0*)(\d+)\.rar$/i
const SEVENZ_PART = /^(.*\.7z)\.(\d{3})$/i

/** Type d'archive (.7z/.rar, y compris volumes `.partN.rar` et `.7z.001`) et premier volume ; null si ce n'est pas une archive gérée ici. */
export function archiveVolume(path: string): ArchiveVolume | null {
  const rarPart = RAR_PART.exec(path)
  if (rarPart) {
    const n = Number(rarPart[3])
    const width = rarPart[2].length + rarPart[3].length
    const first = `${rarPart[1]}.part${'1'.padStart(width, '0')}.rar`
    return { kind: 'rar', first, isFirst: n === 1 }
  }
  const sevenPart = SEVENZ_PART.exec(path)
  if (sevenPart) return { kind: '7z', first: `${sevenPart[1]}.001`, isFirst: sevenPart[2] === '001' }
  const ext = extname(path).toLowerCase()
  if (ext === '.7z') return { kind: '7z', first: path, isFirst: true }
  if (ext === '.rar') return { kind: 'rar', first: path, isFirst: true }
  return null
}

/** Tous les fichiers de volumes à supprimer avec l'archive une fois importée (le premier volume inclus). */
export async function archiveFiles(first: string): Promise<string[]> {
  const dir = dirname(first), name = basename(first)
  const files = [first]
  const rarPart = RAR_PART.exec(name)
  const sevenPart = SEVENZ_PART.exec(name)
  const oldRar = /^(.*)\.rar$/i.exec(name)
  let match: (n: string) => boolean
  if (rarPart) match = (n) => RAR_PART.exec(n)?.[1] === rarPart[1]
  else if (sevenPart) match = (n) => SEVENZ_PART.exec(n)?.[1] === sevenPart[1]
  else if (oldRar) match = (n) => new RegExp(`^${oldRar[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[rs]\\d\\d$`, 'i').test(n)
  else return files
  for (const n of await readdir(dir).catch(() => [] as string[])) if (n !== name && match(n)) files.push(join(dir, n))
  return files
}

/** Garde-fous contre une bombe de décompression : tailles et nombre d'entrées annoncés par la liste, vérifiés AVANT d'extraire. */
const MAX_UNPACKED_BYTES = 256 * 1024 ** 3
const MAX_ENTRIES = 100_000

/** Programme exécuté dans le processus enfant : monte les disques utiles (NODEFS) et lance 7-Zip avec les arguments reçus. */
const RUNNER = `
const SevenZip = require(process.env.SZ_JS)
const job = JSON.parse(process.env.SZ_JOB)
const bytes = []
const sink = (c) => { if (c !== null) bytes.push(c & 255) }
const toH = (p) => '/h/' + p[0].toUpperCase() + p.slice(2).replace(/\\\\/g, '/')
SevenZip({ stdin: () => null, stdout: sink, stderr: sink }).then((sz) => {
  const chmod = sz.FS.chmod
  sz.FS.chmod = (p, m, d) => { if (m) chmod(p, m, d) }
  sz.FS.mkdir('/h')
  for (const r of job.roots) { const m = '/h/' + r[0].toUpperCase(); sz.FS.mkdir(m); sz.FS.mount(sz.NODEFS, { root: r }, m) }
  sz.FS.chdir(job.cwd ? toH(job.cwd) : '/h')
  let code = 0
  try { code = sz.callMain(job.args) || 0 } catch (e) { code = e && typeof e.status === 'number' ? e.status : 2 }
  process.stdout.write(Buffer.from(bytes))
  process.exitCode = code
}).catch(() => { process.exitCode = 2 })
`

/** Chemin du moteur ; hors de l'asar quand il y est dépaqueté (electron-builder `asarUnpack`) — fichier réel, remplaçable (LGPL). */
function enginePath(): string {
  const p = createRequire(__filename).resolve('7z-wasm')
  const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  return unpacked !== p && existsSync(unpacked) ? unpacked : p
}

/** Chemin hôte -> chemin dans le système de fichiers virtuel du moteur (`/h/<lettre>/…`). Null si le chemin n'est pas sur un lecteur (UNC…). */
export const toVirtual = (p: string): string | null => /^[a-z]:[\\/]/i.test(p) ? '/h/' + p[0].toUpperCase() + p.slice(2).replace(/\\/g, '/') : null

interface RunResult { code: number; out: string }

export async function run7z(args: string[], paths: string[], cwd?: string): Promise<RunResult> {
  const roots = [...new Set([...paths, ...(cwd ? [cwd] : [])].map((p) => parse(resolve(p)).root.toUpperCase()))]
  const job = { roots, cwd: cwd ? resolve(cwd) : undefined, args }
  return new Promise((done) => {
    execFile(process.execPath, ['-e', RUNNER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SZ_JS: enginePath(), SZ_JOB: JSON.stringify(job) },
      maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'buffer'
    }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 2) : 0
      done({ code, out: Buffer.from(stdout ?? '').toString('utf8') })
    })
  })
}

interface ListedEntry { path: string; size: number; folder: boolean; encrypted: boolean; link: boolean }
interface Listing { type: string; entries: ListedEntry[]; multiVolume: boolean }

/** Sortie de `7z l -slt` : un bloc d'en-tête (type de l'archive…) puis un bloc « clé = valeur » par entrée. */
function parseListing(out: string): Listing {
  const cut = out.indexOf('\n----------')
  const head = cut >= 0 ? out.slice(0, cut) : out
  const body = cut >= 0 ? out.slice(cut + 11) : ''
  const kv = (block: string): Record<string, string> => {
    const r: Record<string, string> = {}
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' = ')
      if (i > 0) r[line.slice(0, i)] = line.slice(i + 3)
    }
    return r
  }
  const h = kv(head)
  const entries = body.split(/\r?\n\r?\n/).map(kv).filter((e) => e.Path !== undefined).map((e): ListedEntry => ({
    path: e.Path,
    size: Number(e.Size ?? 0) || 0,
    folder: e.Folder === '+' || /^D/.test(e.Attributes ?? ''),
    encrypted: e.Encrypted === '+',
    // 7-Zip écrit ces clés à vide pour un fichier ordinaire : seule une valeur non vide signale un lien.
    link: !!e['Symbolic Link'] || !!e['Hard Link'] || !!e['Copy Link'] || /\bl[r-][w-][x-]/.test(e.Attributes ?? '')
  }))
  return { type: h.Type ?? '', entries, multiVolume: Number(h.Volumes) > 1 || h.Multivolume === '+' }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Faux si le chemin d'une entrée pourrait sortir du dossier d'extraction ou viser autre chose qu'un fichier ordinaire (Windows compris). */
export function isSafeEntryPath(p: string): boolean {
  if (!p || p.includes('\0') || /[\x00-\x1f]/.test(p)) return false
  if (/^[\\/]/.test(p) || /^[a-z]:/i.test(p) || p.includes(':')) return false // absolu, lecteur, flux de données alternatif
  return p.split(/[\\/]/).every((seg) => seg !== '' && seg !== '..' && !RESERVED.test(seg) && !/[. ]$/.test(seg) && !/[<>"|?*]/.test(seg))
}

/** Message d'erreur lisible depuis la sortie de 7-Zip. */
function explain(out: string, multi: boolean): string {
  if (/Wrong password|Enter password|encrypted archive/i.test(out)) return 'archive protégée par mot de passe (non prise en charge)'
  if (/Missing volume|Cannot find volume|can not find.*volume/i.test(out) || (multi && /Unexpected end of archive/i.test(out))) return 'archive en plusieurs volumes : un volume est manquant'
  if (/Can not open the file as|Is not archive|Headers Error|Data Error|CRC Failed|Unexpected end|data after the end|Unsupported Method/i.test(out)) return 'archive corrompue ou illisible'
  const line = out.split(/\r?\n/).find((l) => /ERROR/i.test(l))
  return `extraction de l’archive échouée${line ? ` (${line.replace(/^ERROR:\s*/i, '').slice(0, 120)})` : ''}`
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else out.push(p)
  }
}

const extOf = (p: string): string => extname(p).slice(1).toLowerCase()

/** Dossier racine d'un paquet PS Vita (eboot.bin + sce_sys/ côte à côte), ou null. */
function vitaRoot(files: string[]): string | null {
  for (const f of files) {
    if (basename(f).toLowerCase() !== 'eboot.bin') continue
    const dir = dirname(f)
    const prefix = join(dir, 'sce_sys') + sep
    if (files.some((x) => x.toLowerCase().startsWith(prefix.toLowerCase()))) return dir
  }
  return null
}

/** Dossier de travail d'une extraction : un sous-dossier par archive, hors de `.import-tmp` (nettoyé en bloc par importPaths) pour que des installs simultanés ne s'effacent pas mutuellement. */
export const newWorkDir = (romsDir: string, tag: string): string => join(romsDir, '.archive-tmp', `${process.pid}-${Date.now()}-${tag}`)

/** Supprime le dossier de travail, puis son parent s'il est vide (jamais s'il sert encore à une autre extraction). */
export async function cleanupWorkDir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  await rmdir(dirname(workDir)).catch(() => undefined)
}

export interface UnpackedArchive {
  /** Fichier à importer, dans `workDir` (que l'appelant supprime ensuite) : la ROM, ou un .zip reconstitué pour un jeu à plusieurs fichiers. */
  file: string
  /** Fichiers de l'archive d'origine (tous les volumes), à supprimer après un import réussi. */
  volumes: string[]
}

/**
 * Extrait une archive .7z/.rar dans `workDir` (créé ici, à supprimer par l'appelant, succès ou échec) et renvoie
 * le fichier à importer, ou un message d'erreur. Une seule ROM : la ROM elle-même. Plusieurs fichiers d'un même jeu
 * (disque .cue + pistes, paquet PS Vita) : reconditionnés en .zip — le chemin d'import des .zip existants s'en
 * charge. Plusieurs ROM différentes : refus explicite. Rien n'est écrit hors de `workDir`.
 */
export async function unpackArchive(archive: string, workDir: string): Promise<UnpackedArchive | string> {
  const vol = archiveVolume(archive)
  if (!vol) return 'format d’archive non pris en charge'
  if (!existsSync(vol.first)) return `archive en plusieurs volumes : premier volume manquant (${basename(vol.first)})`
  if (!vol.isFirst) return `volume d’archive : importer le premier volume (${basename(vol.first)})`
  const src = toVirtual(resolve(archive))
  const content = join(workDir, 'content')
  const virtualContent = toVirtual(content)
  if (!src || !virtualContent) return 'chemin d’archive non pris en charge'
  await mkdir(content, { recursive: true })

  const listed = await run7z(['l', '-slt', '-sccUTF-8', '-bd', src], [archive])
  const multiHint = !!vol.first && (RAR_PART.test(vol.first) || SEVENZ_PART.test(vol.first))
  const listing = parseListing(listed.out)
  if (listed.code > 1 || !listing.type) return explain(listed.out, multiHint || listing.multiVolume)
  if (!['7z', 'Rar', 'Rar5'].includes(listing.type)) return 'format d’archive non pris en charge'
  const files = listing.entries.filter((e) => !e.folder)
  if (listing.entries.some((e) => e.encrypted)) return 'archive protégée par mot de passe (non prise en charge)'
  if (files.length === 0) return 'archive vide'
  if (listing.entries.length > MAX_ENTRIES) return 'archive refusée : trop d’entrées'
  if (files.reduce((s, e) => s + e.size, 0) > MAX_UNPACKED_BYTES) return 'archive refusée : contenu décompressé trop volumineux'
  const bad = listing.entries.find((e) => e.link || !isSafeEntryPath(e.path))
  if (bad) return `archive refusée : entrée dangereuse ou au nom invalide (${bad.path.slice(0, 80)})`

  const extracted = await run7z(['x', '-y', '-aoa', '-bd', '-sccUTF-8', `-o${virtualContent}`, src], [archive, content])
  if (extracted.code !== 0) return explain(extracted.out, multiHint || listing.multiVolume)

  // Défense en profondeur : ce qui est réellement sur disque doit être uniquement des fichiers ordinaires dans `content`.
  const onDisk: string[] = []
  await walk(content, onDisk)
  const root = resolve(content) + sep
  for (const f of onDisk) {
    const st = await lstat(f)
    if (!st.isFile() || !(resolve(f) + '').startsWith(root)) return 'archive refusée : entrée dangereuse'
  }

  const roms = onDisk.filter((f) => extOf(f) in ROM_EXTENSIONS)
  const volumes = await archiveFiles(vol.first)
  const asZip = async (base: string, members: string[]): Promise<UnpackedArchive | string> => {
    const zip = join(workDir, `${parse(vol.first.replace(/\.part0*1\.rar$/i, '.rar').replace(/\.7z\.001$/i, '.7z')).name}.zip`)
    const list = join(workDir, 'list.txt')
    await writeFile(list, members.map((m) => relative(base, m).replace(/\\/g, '/')).join('\n'), 'utf8')
    const r = await run7z(['a', '-tzip', '-mx0', '-spd', '-scsUTF-8', '-bd', toVirtual(zip)!, `@${toVirtual(list)}`], [zip, list, base], base)
    return r.code === 0 && existsSync(zip) ? { file: zip, volumes } : 'reconstitution de l’archive échouée'
  }

  // Paquet PS Vita (contenu à la racine : eboot.bin + sce_sys/) : remis à la racine d'un .zip, comme un .vpk.
  const vita = vitaRoot(onDisk)
  if (vita) return asZip(vita, onDisk.filter((f) => f.toLowerCase().startsWith((vita + sep).toLowerCase())))
  if (roms.length === 1) return { file: roms[0], volumes }
  // Disque .cue + pistes : une unique feuille .cue qui référence exactement les autres ROM.
  const cues = roms.filter((f) => extOf(f) === 'cue')
  if (cues.length === 1) {
    const refs = [...(await readFile(cues[0], 'latin1')).matchAll(/^\s*FILE\s+"([^"]+)"/gim)].map((m) => basename(m[1]).toLowerCase())
    const tracks = refs.map((r) => roms.find((f) => basename(f).toLowerCase() === r)).filter((f): f is string => !!f)
    if (refs.length > 0 && tracks.length === refs.length && tracks.length + 1 === roms.length) return asZip(content, [cues[0], ...tracks])
  }
  return roms.length === 0 ? 'archive : aucune ROM reconnue' : 'archive : un seul fichier de ROM attendu (ou un .cue avec ses pistes)'
}
