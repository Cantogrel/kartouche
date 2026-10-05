/** Blocs de l'accueil (classique et Big Picture) : le « collections » regroupe une rangée par collection non vide. */
export const HOME_SECTIONS = ['stats', 'continue', 'favorites', 'recent', 'collections'] as const
export type HomeSection = (typeof HOME_SECTIONS)[number]

export interface HomeLayout {
  /** Ordre d'affichage (toujours une permutation complète de HOME_SECTIONS). */
  order: HomeSection[]
  hidden: HomeSection[]
}

export const DEFAULT_HOME_LAYOUT: HomeLayout = { order: [...HOME_SECTIONS], hidden: [] }

const isSection = (x: unknown): x is HomeSection => typeof x === 'string' && (HOME_SECTIONS as readonly string[]).includes(x)

/** Saisie non fiable → disposition valide : doublons et inconnus ignorés, blocs manquants ajoutés à la fin. */
export function normalizeHomeLayout(raw: unknown): HomeLayout {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const order = [...new Set(Array.isArray(r.order) ? r.order.filter(isSection) : [])]
  for (const s of HOME_SECTIONS) if (!order.includes(s)) order.push(s)
  const hidden = [...new Set(Array.isArray(r.hidden) ? r.hidden.filter(isSection) : [])]
  return { order, hidden }
}

/** Blocs à afficher, dans l'ordre choisi. */
export const visibleHomeSections = (l: HomeLayout): HomeSection[] => l.order.filter((s) => !l.hidden.includes(s))

/** Déplace un bloc d'un cran (−1 = vers le haut, +1 = vers le bas) ; inchangé en butée. */
export function moveHomeSection(l: HomeLayout, s: HomeSection, delta: -1 | 1): HomeLayout {
  const i = l.order.indexOf(s)
  const j = i + delta
  if (i < 0 || j < 0 || j >= l.order.length) return l
  const order = [...l.order]
  ;[order[i], order[j]] = [order[j], order[i]]
  return { ...l, order }
}

/** Place un bloc à une position donnée de la liste (glisser-déposer) ; inchangé si la position est celle d'origine ou hors liste. */
export function reorderHomeSection(l: HomeLayout, s: HomeSection, to: number): HomeLayout {
  const from = l.order.indexOf(s)
  if (from < 0 || to < 0 || to >= l.order.length || to === from) return l
  const order = l.order.filter((x) => x !== s)
  order.splice(to, 0, s)
  return { ...l, order }
}

export function toggleHomeSection(l: HomeLayout, s: HomeSection): HomeLayout {
  return { ...l, hidden: l.hidden.includes(s) ? l.hidden.filter((x) => x !== s) : [...l.hidden, s] }
}
