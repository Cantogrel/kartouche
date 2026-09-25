import type { ConsoleDef } from '@shared/consoles'
import { isVariant, metaByTitle, parseDat, type DatGame } from './datParser'
import type { CatalogRow } from './catalogStore'

const RAW = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat'
const THUMBS = 'https://thumbnails.libretro.com'

export type Fetcher = (url: string) => Promise<string | null>

/** Télécharge un texte ; null si le fichier n'existe pas (404), erreur sinon. */
export const httpText: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

const datUrl = (kind: string, system: string): string => `${RAW}/${kind}/${encodeURIComponent(system)}.dat`

/** Assemble le catalogue d'une console : DAT No-Intro/Redump + genre, année et développeur. */
export async function fetchConsoleCatalog(def: ConsoleDef, get: Fetcher = httpText): Promise<{ rows: CatalogRow[]; version: string | null }> {
  const main = await get(datUrl(def.dat, def.system))
  if (main === null) throw new Error(`DAT introuvable pour ${def.label}`)
  const games = parseDat(main)
  const optional = async (kind: string): Promise<DatGame[]> => {
    try { const t = await get(datUrl(kind, def.system)); return t ? parseDat(t) : [] } catch { return [] }
  }
  const [genre, year, dev] = await Promise.all([optional('genre'), optional('releaseyear'), optional('developer')])
  const g = metaByTitle(genre, 'genre'), y = metaByTitle(year, 'releaseyear'), d = metaByTitle(dev, 'developer')
  const rows: CatalogRow[] = games.filter((x) => x.name).map((x) => {
    const yr = Number.parseInt(y.get(x.name) ?? '', 10)
    return {
      title: x.name, region: x.region ?? '', year: Number.isFinite(yr) ? yr : null,
      genre: g.get(x.name) ?? null, developer: d.get(x.name) ?? null,
      crc: x.rom.crc?.toUpperCase() ?? null, sha1: x.rom.sha1?.toUpperCase() ?? null,
      size: x.rom.size ? Number(x.rom.size) : null, variant: isVariant(x.name)
    }
  })
  return { rows, version: /^\s*version\s+"([^"]*)"/m.exec(main)?.[1] ?? null }
}

// Libretro remplace les caractères & * / : < > ? \ | par _ dans les noms de vignettes.
export const thumbnailName = (title: string): string => title.replace(/[&*/:<>?\\|]/g, '_')

export const thumbnailUrl = (def: ConsoleDef, title: string, kind: 'Named_Boxarts' | 'Named_Snaps' | 'Named_Titles' = 'Named_Boxarts'): string =>
  `${THUMBS}/${encodeURIComponent(def.system)}/${kind}/${encodeURIComponent(thumbnailName(title))}.png`
