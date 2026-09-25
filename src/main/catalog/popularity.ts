import type { DatabaseSync } from 'node:sqlite'
import type { Settings } from '@shared/settings'
import { CONSOLES } from '@shared/consoles'
import { mainGenre } from '@shared/genres'
import { IGDB_FIELDS, companyOf, igdbQuery, igdbToken, platformYear, type IgdbRow } from './igdb'

/** Clé de rapprochement entre un titre No-Intro/Redump et un nom IGDB : « Legend of Zelda, The - Link (USA) » ≈ « The Legend of Zelda: Link ». */
export function matchKey(title: string): string {
  return title
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/^(.*?), (The|A|An)\b(.*)$/i, '$2 $1$3')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '')
}

const PAGE = 500
const MAX_PAGES = 30 // garde-fou : la plus grosse plateforme (PS2) tient en une dizaine de pages

interface Known { rating: number; genre: string | null; developer: string | null; year: number | null }

/**
 * Passe IGDB sur tout le catalogue : pour chaque plateforme, tous les jeux d'IGDB, rapprochés des titres du catalogue par nom.
 * Renseigne la popularité (nombre d'évaluations) et complète genre, développeur et année LÀ OÙ LES DAT NE LES DONNENT PAS
 * (jamais d'écrasement d'une valeur existante). L'année est celle de la plateforme, pas la première sortie tous supports.
 * Retourne le nombre de jeux rapprochés.
 */
export async function syncPopularity(db: DatabaseSync, settings: Settings, onStep: (done: number, total: number) => void = () => undefined,
  query: typeof igdbQuery = igdbQuery): Promise<number> {
  const token = await igdbToken(settings)
  // La Switch est déjà renseignée : son catalogue vient d'IGDB avec toutes ces données.
  const defs = CONSOLES.filter((c) => c.id !== 'switch')
  const upd = db.prepare('UPDATE catalog_games SET popularity = ?, genre = COALESCE(genre, ?), developer = COALESCE(developer, ?), year = COALESCE(year, ?) WHERE id = ?')
  let matched = 0
  let done = 0
  for (const def of defs) {
    const known = new Map<string, Known>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await query<IgdbRow>(settings, token,
        `fields ${IGDB_FIELDS}; where platforms = (${def.igdb}); sort id asc; limit ${PAGE}; offset ${page * PAGE};`)
      for (const r of rows) {
        const k = matchKey(r.name)
        const rating = r.total_rating_count ?? 0
        const prev = known.get(k)
        if (k && (!prev || rating > prev.rating)) known.set(k, { rating, genre: mainGenre(r.genres?.map((g) => g.name)), developer: companyOf(r), year: platformYear(r, def.igdb) })
      }
      if (rows.length < PAGE) break
    }
    const games = db.prepare('SELECT id, title FROM catalog_games WHERE console = ?').all(def.id) as { id: number; title: string }[]
    db.exec('BEGIN')
    try {
      for (const g of games) {
        const k = known.get(matchKey(g.title))
        if (k) { upd.run(k.rating || null, k.genre, k.developer, k.year, g.id); matched++ }
      }
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    onStep(++done, defs.length)
  }
  return matched
}
