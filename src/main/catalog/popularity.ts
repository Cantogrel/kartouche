import type { DatabaseSync } from 'node:sqlite'
import type { Settings } from '@shared/settings'
import { igdbToken, igdbQuery } from './igdb'

/** Identifiants de plateforme IGDB par console du catalogue. */
export const IGDB_PLATFORMS: Record<string, number> = {
  nes: 18, snes: 19, n64: 4, gb: 33, gbc: 22, gba: 24, nds: 20, n3ds: 37, gc: 21, wii: 5, wiiu: 41, switch: 130, ps1: 7, ps2: 8, ps3: 9, psp: 38, vita: 46
}

/** Clé de rapprochement entre un titre No-Intro/Redump et un nom IGDB : « Legend of Zelda, The - Link (USA) » ≈ « The Legend of Zelda: Link ». */
export function matchKey(title: string): string {
  return title
    .replace(/\s*[([][^)\]]*[)\]]/g, '')
    .replace(/^(.*?), (The|A|An)\b(.*)$/i, '$2 $1$3')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '')
}

const PAGE = 500
const MAX_PAGES = 4 // top 2000 par plateforme : au-delà, les jeux sont peu connus et le score n'aide plus au tri

/** Récupère pour chaque console les jeux les plus notés d'IGDB et note les titres du catalogue (nombre d'évaluations). Retourne le nombre de jeux notés. */
export async function syncPopularity(db: DatabaseSync, settings: Settings, onStep: (done: number, total: number) => void = () => undefined,
  query: typeof igdbQuery = igdbQuery): Promise<number> {
  const token = await igdbToken(settings)
  // La Switch est déjà classée : son catalogue vient d'IGDB avec le score.
  const consoles = Object.keys(IGDB_PLATFORMS).filter((c) => c !== 'switch')
  const upd = db.prepare('UPDATE catalog_games SET popularity = ? WHERE id = ?')
  let rated = 0
  let done = 0
  for (const c of consoles) {
    const score = new Map<string, number>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await query<{ name: string; total_rating_count?: number }>(settings, token,
        `fields name,total_rating_count; where platforms = (${IGDB_PLATFORMS[c]}) & total_rating_count > 0; sort total_rating_count desc; limit ${PAGE}; offset ${page * PAGE};`)
      for (const r of rows) {
        const k = matchKey(r.name)
        if (k && (score.get(k) ?? 0) < (r.total_rating_count ?? 0)) score.set(k, r.total_rating_count ?? 0)
      }
      if (rows.length < PAGE) break
    }
    const games = db.prepare('SELECT id, title FROM catalog_games WHERE console = ?').all(c) as { id: number; title: string }[]
    db.exec('BEGIN')
    try {
      for (const g of games) {
        const v = score.get(matchKey(g.title))
        if (v !== undefined) { upd.run(v, g.id); rated++ }
      }
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    onStep(++done, consoles.length)
  }
  return rated
}
