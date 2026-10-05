import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { isImageField, normalizeOverride, type OverrideImageField } from '@shared/overrides'
import { clearOverride, getOverrides, setOverride } from './overrides'

/*
 * Images personnelles d'un jeu (jaquette, icône, bannière, fond) : copiées dans <data>/custom-art/<id de l'entrée>/<champ>-<horodatage>.<ext>,
 * jamais référencées à leur emplacement d'origine (le fichier peut disparaître, ou être sur un autre disque). Le chemin relatif est la valeur
 * de la surcharge (`library_overrides`, voir shared/overrides.ts) et sert d'adresse `kimg://custom/<chemin relatif>`.
 * Comme `overrides.ts`, ce module est réservé à l'affichage : identification, téléchargements et sources ne l'importent pas.
 */

/** Taille maximale d'une image acceptée. Au-delà, ce n'est plus une jaquette : refusée plutôt que copiée. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024

export const customArtDir = (dataDir: string): string => join(dataDir, 'custom-art')

export type ImageType = 'png' | 'jpg' | 'webp'
const MIME: Record<ImageType, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }

/** Format réel d'après les premiers octets (jamais d'après l'extension : un .png peut être autre chose), ou null si ce n'est pas une image acceptée. */
export function sniffImage(head: Buffer): ImageType | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

/** Chemin absolu d'une image personnelle, ou null s'il sort du dossier des images personnelles, ou n'existe pas. */
export function resolveCustomArtPath(dataDir: string, rel: string): string | null {
  if (normalizeOverride('cover', rel) !== rel) return null // mêmes règles que la valeur d'une surcharge : relatif, sans « .. », en slashs
  const root = resolve(customArtDir(dataDir))
  const abs = resolve(root, rel)
  return abs.startsWith(root + sep) && existsSync(abs) ? abs : null
}

/** Contenu et type d'une image personnelle (pour le protocole `kimg://custom/…`), ou null. */
export async function readCustomArt(dataDir: string, rel: string): Promise<{ data: Buffer; type: string } | null> {
  const abs = resolveCustomArtPath(dataDir, rel)
  if (!abs) return null
  try {
    const data = await readFile(abs)
    const kind = sniffImage(data)
    return kind ? { data, type: MIME[kind] } : null
  } catch { return null }
}

export interface SaveImageOptions {
  /** Réduit une image trop grande (Electron : `nativeImage`) ; absent = copie telle quelle. Reçoit le contenu et son format, rend le nouveau contenu et son format. */
  downscale?: (data: Buffer, type: ImageType) => { data: Buffer; type: ImageType }
}

export type SaveImageResult = { ok: true; path: string } | { ok: false; reason: 'entry' | 'field' | 'missing' | 'tooLarge' | 'notImage' | 'unreadable' }

/**
 * Copie `sourcePath` dans le dossier des images personnelles et en fait la surcharge `field` de l'entrée. L'image précédente du champ est supprimée.
 * Aucune surcharge n'est écrite si le fichier est refusé (absent, trop gros, pas une image png/jpg/webp).
 */
export async function setCustomImage(db: DatabaseSync, dataDir: string, entryId: number, field: OverrideImageField, sourcePath: string, opts: SaveImageOptions = {}): Promise<SaveImageResult> {
  if (!isImageField(field)) return { ok: false, reason: 'field' }
  if (!db.prepare('SELECT 1 FROM library WHERE id = ?').get(entryId)) return { ok: false, reason: 'entry' }
  let info
  try { info = await stat(sourcePath) } catch { return { ok: false, reason: 'missing' } }
  if (!info.isFile()) return { ok: false, reason: 'missing' }
  if (info.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'tooLarge' }
  let data: Buffer
  try { data = await readFile(sourcePath) } catch { return { ok: false, reason: 'unreadable' } }
  let type = sniffImage(data)
  if (!type) return { ok: false, reason: 'notImage' }
  if (opts.downscale) ({ data, type } = opts.downscale(data, type))

  const rel = `${entryId}/${field}-${Date.now()}.${type}`
  const previous = getOverrides(db, entryId)[field]
  await mkdir(join(customArtDir(dataDir), String(entryId)), { recursive: true })
  await writeFile(join(customArtDir(dataDir), rel), data)
  if (setOverride(db, entryId, field, rel) !== rel) { await rm(join(customArtDir(dataDir), rel), { force: true }); return { ok: false, reason: 'entry' } }
  if (previous && previous !== rel) await removeFile(dataDir, previous)
  return { ok: true, path: rel }
}

/** Rétablit l'image d'origine d'un champ et supprime le fichier personnel. */
export async function clearCustomImage(db: DatabaseSync, dataDir: string, entryId: number, field: OverrideImageField): Promise<void> {
  const previous = getOverrides(db, entryId)[field]
  clearOverride(db, entryId, field)
  if (previous) await removeFile(dataDir, previous)
}

/** Supprime toutes les images personnelles d'une entrée (suppression du jeu, ou « tout rétablir »). Les surcharges d'images sont retirées avec. */
export async function removeEntryArt(db: DatabaseSync | null, dataDir: string, entryId: number): Promise<void> {
  if (db) db.prepare("DELETE FROM library_overrides WHERE entry_id = ? AND field IN ('cover', 'icon', 'banner', 'background')").run(entryId)
  await rm(join(customArtDir(dataDir), String(entryId)), { recursive: true, force: true })
}

/**
 * Supprime les dossiers d'images dont l'entrée n'existe plus (entrée supprimée pendant un arrêt brutal, bibliothèque vidée, remise à zéro…) et,
 * dans les dossiers restants, les fichiers qu'aucune surcharge ne référence. Renvoie le nombre d'éléments supprimés. À lancer au démarrage.
 */
export async function pruneCustomArt(db: DatabaseSync, dataDir: string): Promise<number> {
  const root = customArtDir(dataDir)
  if (!existsSync(root)) return 0
  const used = new Set((db.prepare("SELECT value FROM library_overrides WHERE field IN ('cover', 'icon', 'banner', 'background')").all() as { value: string }[]).map((r) => r.value))
  const ids = new Set((db.prepare('SELECT id FROM library').all() as { id: number }[]).map((r) => String(r.id)))
  let removed = 0
  for (const dir of await readdir(root)) {
    if (!ids.has(dir)) { await rm(join(root, dir), { recursive: true, force: true }); removed++; continue }
    for (const file of await readdir(join(root, dir)).catch(() => [] as string[])) {
      if (used.has(`${dir}/${file}`)) continue
      await rm(join(root, dir, file), { recursive: true, force: true }); removed++
    }
  }
  return removed
}

async function removeFile(dataDir: string, rel: string): Promise<void> {
  const abs = resolveCustomArtPath(dataDir, rel)
  if (abs) await rm(abs, { force: true })
}
