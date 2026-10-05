/** Médias d'un jeu (IGDB) : bande-annonces, captures d'écran et artworks. Seuls des identifiants sont stockés ; les adresses sont construites ici, jamais prises telles quelles d'un service. */
export interface GameMedia {
  /** Vidéos YouTube (identifiant de vidéo), la plus pertinente d'abord. */
  trailers: { id: string; name: string }[]
  /** Identifiants d'image IGDB (`image_id`). */
  screenshots: string[]
  artworks: string[]
}

/** Identifiant YouTube (11 caractères) ou d'image IGDB : lettres, chiffres, `_` et `-` seulement, sinon il est ignoré. */
export const isMediaId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{5,24}$/.test(v)

export type IgdbImageSize = 't_thumb' | 't_screenshot_med' | 't_screenshot_big' | 't_1080p' | 't_cover_big'
export const igdbImageUrl = (id: string, size: IgdbImageSize = 't_screenshot_big'): string => `https://images.igdb.com/igdb/image/upload/${size}/${id}.jpg`

/** Lecteur intégré (domaine sans cookies de YouTube). */
export const youtubeEmbedUrl = (id: string, opts: { autoplay?: boolean } = {}): string =>
  `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&enablejsapi=1${opts.autoplay ? '&autoplay=1' : ''}`
export const youtubeWatchUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`

const TRAILER_RANK: [RegExp, number][] = [[/\b(launch|release|official)\b.*trailer|trailer.*\b(launch|release|official)\b/i, 0], [/trailer/i, 1], [/gameplay|walkthrough|overview/i, 2]]
const rank = (name: string): number => TRAILER_RANK.find(([re]) => re.test(name))?.[1] ?? 3

/** Vidéos IGDB → bandes-annonces : identifiants valides, sans doublon, trailers d'abord, 5 au plus. */
export function pickTrailers(videos: { video_id?: unknown; name?: unknown }[] | undefined): GameMedia['trailers'] {
  const seen = new Set<string>()
  const out: GameMedia['trailers'] = []
  for (const v of videos ?? []) {
    if (!isMediaId(v.video_id) || seen.has(v.video_id)) continue
    seen.add(v.video_id)
    out.push({ id: v.video_id, name: typeof v.name === 'string' ? v.name.slice(0, 80) : '' })
  }
  return out.map((v, i) => ({ v, i })).sort((a, b) => rank(a.v.name) - rank(b.v.name) || a.i - b.i).slice(0, 5).map((x) => x.v)
}

/** Images IGDB → identifiants valides, sans doublon, `max` au plus. */
export function pickImages(images: { image_id?: unknown }[] | undefined, max = 12): string[] {
  const out: string[] = []
  for (const im of images ?? []) if (isMediaId(im.image_id) && !out.includes(im.image_id)) out.push(im.image_id)
  return out.slice(0, max)
}

/**
 * Image de fond par défaut d'une fiche : une illustration ou capture IGDB qui n'est PAS celle de la bannière (sinon elle passe derrière et ne se voit pas).
 * `bannerFromIgdb` : la bannière est elle-même une image IGDB (jeux PC : première illustration, à défaut première capture).
 */
export function defaultBackgroundId(media: Pick<GameMedia, 'screenshots' | 'artworks'> | null | undefined, bannerFromIgdb: boolean): string | null {
  if (!media) return null
  const bannerId = bannerFromIgdb ? media.artworks[0] ?? media.screenshots[0] : undefined
  return [...media.screenshots, ...media.artworks].find((id) => id !== bannerId) ?? null
}

const NOT_THE_GAME = /anime|animated series|episode|\bep\.? ?\d|season|\btv\b|cartoon|movie|film|opening|ending|review|reaction|let'?s play|soundtrack|\bost\b|\bamv\b|compilation|top \d+/i

/**
 * Pénalité (0 = bon candidat) du titre YouTube d'une vidéo pour la bande-annonce de CE jeu. Les noms IGDB sont presque tous « Trailer » : seul le titre de la
 * vidéo distingue la bande-annonce du jeu de celle d'une série animée, d'un film ou d'une suite (« … 2 » alors que le jeu n'a pas ce numéro).
 */
export function trailerTitlePenalty(title: string, gameName: string): number {
  let p = 0
  if (NOT_THE_GAME.test(title)) p += 10
  const numbersIn = (x: string): Set<string> => new Set(x.match(/\b\d{1,2}\b/g) ?? [])
  const wanted = numbersIn(gameName)
  if ([...numbersIn(title)].some((n) => !wanted.has(n))) p += 6
  const words = gameName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^(the|version|edition|and)$/.test(w))
  const hay = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (words.length > 0 && !words.some((w) => hay.includes(w))) p += 4
  return p
}

/** Réordonne les bandes-annonces d'après le titre de leur vidéo (stable : à pénalité égale, l'ordre d'IGDB est conservé) et remplace le nom générique « Trailer » par ce titre. */
export function rankTrailersByTitle(trailers: GameMedia['trailers'], titles: (string | null)[], gameName: string): GameMedia['trailers'] {
  return trailers
    .map((v, i) => ({ v: titles[i] ? { ...v, name: titles[i]!.slice(0, 80) } : v, i, p: titles[i] ? trailerTitlePenalty(titles[i]!, gameName) : 2 }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.v)
}
