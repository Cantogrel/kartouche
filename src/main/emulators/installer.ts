import type { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RETROARCH_CORES, type EmulatorDef, type EmulatorProgress } from '@shared/emulators'
import type { AppPaths } from '@shared/ipc'
import { coreUrl, latestRelease } from './source'
import { deleteEmulator, getRow, saveEmulator } from './emulatorStore'
import { configureEmulator, type ConfigContext } from './configure'
import { installResolutionPacks, maxRenderHeight } from './cemu'
import { detectGpu } from './gpu'
import { hasQuarterResolutions } from './eden'

type Report = (p: EmulatorProgress) => void

/** bsdtar (livré avec Windows 10+) lit zip et 7z : aucune dépendance à ajouter. */
const tarExe = (): string => join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env })
    let err = ''
    p.stderr.on('data', (d) => { err += String(d) })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${basename(cmd)} a échoué (${code}) : ${err.trim().slice(0, 300)}`))))
  })
}

/** Extrait une archive. Un zip que bsdtar refuse (nom de fichier illisible, ex. Cemu) est repris par PowerShell. */
export async function extract(archive: string, dest: string): Promise<void> {
  try {
    await run(tarExe(), ['-xf', archive, '-C', dest])
  } catch (e) {
    if (!archive.toLowerCase().endsWith('.zip')) throw e
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:RV_ARCHIVE -DestinationPath $env:RV_DEST -Force'], { RV_ARCHIVE: archive, RV_DEST: dest })
  }
}

export async function download(url: string, file: string, onProgress: (done: number, total: number) => void, userAgent = 'Kartouche'): Promise<void> {
  const res = await fetch(url, { headers: { 'user-agent': userAgent }, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let done = 0
  let last = 0
  const src = Readable.fromWeb(res.body as never)
  src.on('data', (c: Buffer) => {
    done += c.length
    const now = Date.now()
    if (now - last > 150) { last = now; onProgress(done, total) }
  })
  await pipeline(src, createWriteStream(file))
  onProgress(done, done)
}

/** Cherche un exécutable (noms possibles, insensible à la casse) dans un dossier, sur quelques niveaux de profondeur. */
export async function findExe(dir: string, names: readonly string[], depth = 4): Promise<string | null> {
  const wanted = names.map((n) => n.toLowerCase())
  const walk = async (d: string, level: number): Promise<string | null> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const w of wanted) {
      const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === w)
      if (hit) return join(d, hit.name)
    }
    if (level >= depth) return null
    for (const e of entries) if (e.isDirectory()) { const r = await walk(join(d, e.name), level + 1); if (r) return r }
    return null
  }
  return walk(dir, 0)
}

/** Descend dans le dossier racine unique d'une archive (« Dolphin-x64/… ») pour installer à plat. */
export async function flattenRoot(dir: string): Promise<string> {
  let cur = dir
  for (;;) {
    const entries = await readdir(cur, { withFileTypes: true })
    if (entries.length === 1 && entries[0].isDirectory()) cur = join(cur, entries[0].name)
    else return cur
  }
}

/** Mode portable : les données de l'émulateur (configuration, sauvegardes) restent dans son dossier. */
async function configure(def: EmulatorDef, dir: string, paths: AppPaths): Promise<void> {
  if (def.portable?.file) await writeFile(join(dir, def.portable.file), '', { flag: 'a' })
  if (def.portable?.dir) await mkdir(join(dir, def.portable.dir), { recursive: true })
  await mkdir(join(paths.bios, def.id), { recursive: true })
}

async function installCores(def: EmulatorDef, dir: string, cache: string, report: Report): Promise<void> {
  const cores = [...new Set(Object.values(RETROARCH_CORES))]
  const coresDir = join(dir, 'cores')
  await mkdir(coresDir, { recursive: true })
  for (let i = 0; i < cores.length; i++) {
    report({ id: def.id, phase: 'cores', done: i, total: cores.length, message: cores[i] })
    const zip = join(cache, `${cores[i]}_libretro.dll.zip`)
    await download(coreUrl(cores[i]), zip, () => {})
    await extract(zip, coresDir)
    await rm(zip, { force: true })
  }
}

/**
 * Vrai si rien d'une installation précédente ne subsiste (jamais installé, ou dossier/exe supprimé hors de Kartouche, ou
 * installation précédente jamais allée au bout) : dans ce cas les réglages automatiques (langue, manette, plein écran)
 * sont (ré)écrits. Un exécutable enregistré mais absent ne compte pas comme « déjà installé » : il n'y a alors rien à préserver.
 */
export function isFreshInstall(prevRow: { exe: string } | undefined): boolean {
  return !prevRow || !existsSync(prevRow.exe)
}

/** Télécharge la dernière version, l'extrait (par-dessus l'installation existante en cas de mise à jour : les données portables sont conservées) et l'enregistre. */
export async function installEmulator(db: DatabaseSync, def: EmulatorDef, paths: AppPaths, report: Report, ctx: Omit<ConfigContext, 'biosDir'>): Promise<void> {
  const id = def.id
  // Réglages automatiques (langue, plein écran, résolution, manette) seulement à la première installation : une mise à jour garde ceux de l'utilisateur.
  const fresh = isFreshInstall(getRow(db, id))
  const cache = join(paths.cache, 'downloads')
  const tmp = join(paths.emulators, `${id}.tmp`)
  try {
    report({ id, phase: 'resolve', done: 0, total: 0 })
    const rel = await latestRelease(def)
    await mkdir(cache, { recursive: true })
    const archive = join(cache, basename(rel.name))
    await download(rel.url, archive, (done, total) => report({ id, phase: 'download', done, total }))
    report({ id, phase: 'extract', done: 0, total: 0 })
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    await extract(archive, tmp)
    await rm(archive, { force: true })
    const dest = join(paths.emulators, id)
    await mkdir(dest, { recursive: true })
    await cp(await flattenRoot(tmp), dest, { recursive: true, force: true })
    await rm(tmp, { recursive: true, force: true })
    const exe = await findExe(dest, def.exe)
    if (!exe) throw new Error(`${def.exe[0]} introuvable après l'installation`)
    await configure(def, dest, paths)
    const gpu = fresh && (id === 'cemu' || id === 'dolphin' || id === 'retroarch' || id === 'eden' || id === 'melonds' || id === 'azahar' || id === 'duckstation' || id === 'pcsx2' || id === 'rpcs3' || id === 'ppsspp' || id === 'vita3k') ? await detectGpu() : undefined
    // Eden : l'énumération des niveaux de résolution a changé entre versions ; on lit celle du binaire installé.
    const edenNewResolutions = fresh && id === 'eden' ? hasQuarterResolutions(await readFile(exe)) : undefined
    if (fresh) await configureEmulator(id, dest, { ...ctx, biosDir: join(paths.bios, id), gpu, edenNewResolutions })
    // Résolution de Cemu = graphic packs officiels, par jeu : facultatif, Cemu reste utilisable en 720p natif si le téléchargement échoue.
    if (gpu && id === 'cemu') await installResolutionPacks(dest, maxRenderHeight(gpu, ctx.displayHeight), { download: (u, f) => download(u, f, () => {}), extract, cache }).catch(() => {})
    if (id === 'retroarch') await installCores(def, dest, cache, report)
    saveEmulator(db, { id, version: rel.version, dir: dest, exe, custom: false })
    report({ id, phase: 'done', done: 1, total: 1 })
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    report({ id, phase: 'error', done: 0, total: 0, message: e instanceof Error ? e.message : String(e) })
    throw e
  }
}

/** Désinstalle : le dossier est supprimé (données portables comprises) sauf pour un exécutable indiqué à la main, jamais touché. */
export async function uninstallEmulator(db: DatabaseSync, id: string): Promise<void> {
  const r = getRow(db, id)
  if (!r) return
  if (!r.custom) await rm(r.dir, { recursive: true, force: true })
  deleteEmulator(db, id)
}
