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

// game_type IGDB (src/common/settings_enums.h côté serveur, valeurs stables et documentées) : 0 main_game, 8 remake,
// 9 remaster, 10 expanded_game, 11 port. On exclut dlc_addon/expansion/bundle/standalone_expansion/mod/episode/
// season/fork/pack/update. `parent_game` a été abandonné comme filtre : IGDB l'utilise aussi pour relier un portage
// une édition Deluxe à son jeu d'origine sur une autre plateforme (pas seulement le vrai DLC), ce qui excluait à tort
// des jeux complets très populaires — ex. Mario Kart 8 Deluxe (parent_game = Mario Kart 8 Wii U, game_type = 10).
const GAME_TYPES = '0,8,9,10,11'

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
       where platforms = (${SWITCH}) & version_parent = null & game_type = (${GAME_TYPES}); sort total_rating_count desc; limit ${PAGE}; offset ${page * PAGE};`)
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
