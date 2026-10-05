import type { CatalogGame, GameDetails } from './catalog'
import { canonicalGenre } from './genres'

/**
 * Surcouche utilisateur d'un jeu de la bibliothèque (titre, description, images…). Elle ne remplace JAMAIS l'identité du jeu :
 * reconnaissance (hash, nom du catalogue), rapprochement des sources, téléchargements, dossier de sauvegardes et fiche du catalogue
 * continuent de lire le titre d'origine (`LibraryEntry.title`, `CatalogGame`). Seul l'affichage passe par `resolveView`.
 */

export const OVERRIDE_TEXT_FIELDS = ['title', 'description', 'genre', 'year', 'developer'] as const
export const OVERRIDE_IMAGE_FIELDS = ['cover', 'icon', 'banner', 'background'] as const
export const OVERRIDE_FIELDS = [...OVERRIDE_TEXT_FIELDS, ...OVERRIDE_IMAGE_FIELDS] as const

export type OverrideTextField = (typeof OVERRIDE_TEXT_FIELDS)[number]
export type OverrideImageField = (typeof OVERRIDE_IMAGE_FIELDS)[number]
export type OverrideField = (typeof OVERRIDE_FIELDS)[number]

/** Valeurs modifiées par l'utilisateur ; un champ absent = valeur d'origine. */
export type EntryOverrides = Partial<Record<OverrideField, string>>

export const isOverrideField = (v: unknown): v is OverrideField => typeof v === 'string' && (OVERRIDE_FIELDS as readonly string[]).includes(v)
export const isImageField = (f: OverrideField): f is OverrideImageField => (OVERRIDE_IMAGE_FIELDS as readonly string[]).includes(f)

const MAX_LENGTH: Record<OverrideTextField, number> = { title: 200, description: 8000, genre: 200, year: 4, developer: 200 }
export const YEAR_MIN = 1950
export const YEAR_MAX = 2100

/**
 * Valeur enregistrable pour un champ, ou null si elle est vide ou invalide (une valeur vide n'est pas une surcharge : on rétablit
 * l'origine). Texte : espaces de bord retirés, longueur bornée. Année : entier entre YEAR_MIN et YEAR_MAX. Image : chemin relatif au
 * dossier des images personnelles, jamais absolu ni remontant (`..`).
 */
export function normalizeOverride(field: OverrideField, raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v) return null
  if (isImageField(field)) {
    if (/^[a-zA-Z]:|^[\\/]|(^|[\\/])\.\.([\\/]|$)|[\0<>:"|?*]/.test(v) || v.length > 260) return null
    return v.replace(/\\/g, '/')
  }
  if (field === 'year') {
    if (!/^\d{4}$/.test(v)) return null
    const y = Number(v)
    return y >= YEAR_MIN && y <= YEAR_MAX ? String(y) : null
  }
  return v.slice(0, MAX_LENGTH[field])
}

/** Données d'origine d'un jeu (catalogue + fiche), avant surcharge. */
export interface BaseView {
  title: string
  description: string | null
  genre: string | null
  year: number | null
  developer: string | null
}

/** Ce que l'interface affiche : valeurs d'origine, remplacées champ par champ par celles de l'utilisateur. */
export interface EntryView extends BaseView {
  /** Images personnelles (chemins relatifs au dossier des images personnelles) ; absent = image d'origine. */
  images: Partial<Record<OverrideImageField, string>>
  /** Champs que l'utilisateur a modifiés. */
  overridden: OverrideField[]
}

/** Genres d'une valeur de genre (plusieurs possibles, séparés par des virgules, points-virgules ou barres) : sans doublon, 8 au plus. */
export const splitGenres = (genre: string | null | undefined): string[] => [...new Set((genre ?? '').split(/[,;/]+/).map((g) => g.trim()).filter(Boolean))].slice(0, 8)

export function resolveView(base: BaseView, overrides: EntryOverrides = {}): EntryView {
  const year = overrides.year !== undefined ? Number(overrides.year) : base.year
  const images: EntryView['images'] = {}
  for (const f of OVERRIDE_IMAGE_FIELDS) if (overrides[f] !== undefined) images[f] = overrides[f]
  return {
    title: overrides.title ?? base.title,
    description: overrides.description ?? base.description,
    genre: overrides.genre ?? base.genre,
    year: Number.isFinite(year) ? year : base.year,
    developer: overrides.developer ?? base.developer,
    images,
    overridden: OVERRIDE_FIELDS.filter((f) => overrides[f] !== undefined)
  }
}

/** Résultat de l'ajout d'une image personnelle (`library:setImage`) : le chemin enregistré, ou la raison du refus (`cancelled` = sélecteur fermé sans choix). */
export type SetImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'entry' | 'field' | 'missing' | 'tooLarge' | 'notImage' | 'unreadable' | 'cancelled' }

/**
 * Données d'origine d'un jeu pour l'affichage : le catalogue d'abord (année et éditeur propres à la plateforme), puis la fiche des fournisseurs
 * (description, genre…) — même ordre que la fiche du catalogue. `fallbackTitle` : titre de la bibliothèque, quand le jeu n'est pas reconnu.
 * Ne dépend que de ces deux sources : actualiser la fiche met à jour toute valeur d'origine, sans toucher à la surcouche (`resolveView`).
 */
export function baseViewFrom(
  game: Pick<CatalogGame, 'name' | 'year' | 'genre' | 'developer'> | null,
  details: Pick<GameDetails, 'summary' | 'developer' | 'releaseYear' | 'genres'> | null,
  fallbackTitle: string
): BaseView {
  return {
    title: game?.name ?? fallbackTitle,
    description: details?.summary ?? null,
    genre: [...new Set([game?.genre, ...(details?.genres ?? []).map((g) => canonicalGenre(g) ?? g)].filter((g): g is string => !!g))].join(', ') || null,
    year: game?.year ?? details?.releaseYear ?? null,
    developer: game?.developer ?? details?.developer ?? null
  }
}
