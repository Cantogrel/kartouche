/** Genres canoniques : les sources (DAT Libretro, IGDB, TheGamesDB) nomment les genres chacune à sa façon. */
export const GENRES: Record<string, { en: string; fr: string }> = {
  platform: { en: 'Platform', fr: 'Plateforme' },
  rpg: { en: 'Role-playing', fr: 'Jeu de rôle' },
  action: { en: 'Action', fr: 'Action' },
  adventure: { en: 'Adventure', fr: 'Aventure' },
  shooter: { en: 'Shooter', fr: 'Tir' },
  fighting: { en: 'Fighting', fr: 'Combat' },
  beatemup: { en: "Beat 'em up", fr: "Beat'em all" },
  shmup: { en: "Shoot 'em up", fr: "Shoot'em up" },
  racing: { en: 'Racing', fr: 'Course' },
  sports: { en: 'Sports', fr: 'Sport' },
  strategy: { en: 'Strategy', fr: 'Stratégie' },
  simulation: { en: 'Simulation', fr: 'Simulation' },
  puzzle: { en: 'Puzzle', fr: 'Puzzle' },
  pointclick: { en: 'Point-and-click', fr: 'Point-and-click' },
  music: { en: 'Music', fr: 'Musique' },
  party: { en: 'Board & card', fr: 'Jeu de société' },
  quiz: { en: 'Quiz', fr: 'Quiz' },
  educational: { en: 'Educational', fr: 'Éducatif' },
  pinball: { en: 'Pinball', fr: 'Flipper' },
  visualnovel: { en: 'Visual novel', fr: 'Visual novel' },
  arcade: { en: 'Arcade', fr: 'Arcade' },
  indie: { en: 'Indie', fr: 'Indépendant' },
  casual: { en: 'Casual', fr: 'Occasionnel' }
}

// Clé de comparaison : minuscules, sans ponctuation ni espaces.
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

const SYNONYMS: Record<string, string> = {
  platform: 'platform', roleplaying: 'rpg', roleplayingrpg: 'rpg', rpg: 'rpg', action: 'action', adventure: 'adventure',
  shooter: 'shooter', lightgunshooter: 'shooter', fighting: 'fighting', beatemup: 'beatemup', hackandslashbeatemup: 'beatemup',
  shootemup: 'shmup', racing: 'racing', sports: 'sports', sport: 'sports', sportswithanimals: 'sports', huntingandfishing: 'sports',
  strategy: 'strategy', realtimestrategyrts: 'strategy', turnbasedstrategytbs: 'strategy', tactical: 'strategy',
  simulator: 'simulation', simulation: 'simulation', puzzle: 'puzzle', thinking: 'puzzle', pointandclick: 'pointclick',
  music: 'music', musicdancing: 'music', rhythm: 'music', board: 'party', card: 'party', cardboardgame: 'party', gambling: 'party',
  quiz: 'quiz', quiztrivia: 'quiz', educational: 'educational', pinball: 'pinball', visualnovel: 'visualnovel',
  arcade: 'arcade', indie: 'indie', casualgame: 'casual', casual: 'casual', mmo: 'rpg'
}

for (const id of Object.keys(GENRES)) SYNONYMS[id] = id

/** Identifiant canonique d'un genre brut ; null pour « Compilation », « Divers »… qui ne sont pas des genres. */
export function canonicalGenre(raw: string | null | undefined): string | null {
  return raw ? SYNONYMS[norm(raw)] ?? null : null
}

/** Du plus caractéristique au plus générique : « Portal » (puzzle + tir + plateforme) → Puzzle, « The Witcher 3 » → Jeu de rôle. */
const IMPORTANCE = ['rpg', 'fighting', 'strategy', 'simulation', 'sports', 'puzzle', 'shooter', 'racing', 'platform', 'beatemup', 'shmup',
  'pointclick', 'music', 'party', 'quiz', 'visualnovel', 'pinball', 'educational', 'action', 'adventure', 'arcade', 'casual', 'indie']

/** Genre principal parmi les genres bruts d'un jeu (l'ordre des sources n'a aucune signification). */
export function mainGenre(raws: readonly string[] | undefined): string | null {
  const ids = new Set((raws ?? []).map(canonicalGenre).filter((x): x is string => x !== null))
  // Puzzle + Aventure sans rien d'autre : c'est une aventure à énigmes (Zelda), pas un jeu de réflexion.
  if (ids.size === 2 && ids.has('puzzle') && ids.has('adventure')) return 'adventure'
  return IMPORTANCE.find((g) => ids.has(g)) ?? null
}

export const genreLabel = (id: string, lang: 'en' | 'fr'): string => GENRES[id]?.[lang] ?? id
