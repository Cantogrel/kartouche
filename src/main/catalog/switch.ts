import type { Settings } from '@shared/settings'
import { mainGenre } from '@shared/genres'
import type { CatalogRow } from './catalogStore'
import { IGDB_FIELDS, companyOf, igdbQuery, igdbToken, platformYear, type IgdbRow } from './igdb'

const SWITCH = 130
const PAGE = 500
const MAX_PAGES = 12 // 6000 jeux, classés par nombre d'évaluations : au-delà, ce ne sont que des titres quasi inconnus

interface SwitchGame extends IgdbRow {
  screenshots?: { image_id: string }[]; artworks?: { image_id: string }[]; cover?: { image_id: string }
}

/**
 * Libretro n'a aucun DAT Switch : le catalogue vient d'IGDB (jeux de base, sans DLC ni versions parentes).
 * Le score de popularité est fourni directement, et l'image d'illustration est mémorisée pour l'affichage.
 * Genre = le plus caractéristique ; année = celle de la sortie Switch (pas la sortie PC d'origine).
 */
export async function fetchSwitchCatalog(settings: Settings, query: typeof igdbQuery = igdbQuery, token?: string): Promise<CatalogRow[]> {
  const bearer = token ?? await igdbToken(settings)
  const rows: CatalogRow[] = []
  const seen = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const games = await query<SwitchGame>(settings, bearer,
      `fields ${IGDB_FIELDS},screenshots.image_id,artworks.image_id,cover.image_id;
       where platforms = (${SWITCH}) & parent_game = null & version_parent = null; sort total_rating_count desc; limit ${PAGE}; offset ${page * PAGE};`)
    for (const g of games) {
      if (seen.has(g.name)) continue
      seen.add(g.name)
      rows.push({
        title: g.name, region: '', variant: false,
        year: platformYear(g, SWITCH),
        genre: mainGenre(g.genres?.map((x) => x.name)),
        developer: companyOf(g),
        crc: null, sha1: null, size: null,
        popularity: g.total_rating_count ?? null,
        img: g.screenshots?.[0]?.image_id ?? g.artworks?.[0]?.image_id ?? g.cover?.image_id ?? null
      })
    }
    if (games.length < PAGE) break
  }
  return rows
}
