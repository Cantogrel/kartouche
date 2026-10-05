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
