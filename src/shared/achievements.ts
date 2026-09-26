/** Identifiant RetroAchievements de chaque console prise en charge (les autres n'ont pas de succès). */
export const RA_CONSOLES: Record<string, number> = {
  nes: 7, snes: 3, n64: 2, gb: 4, gbc: 6, gba: 5, nds: 18, gc: 16, ps1: 12, ps2: 21, psp: 41
}

export interface Achievement {
  id: number
  title: string
  description: string
  points: number
  /** Nom de l'icône : https://media.retroachievements.org/Badge/<badge>.png (« _lock » pour la version verrouillée). */
  badge: string
  /** Date d'obtention (ms) ; null si non obtenu. */
  earnedAt: number | null
  hardcore: boolean
}

export interface GameAchievements {
  raId: number
  title: string
  total: number
  earned: number
  points: number
  earnedPoints: number
  achievements: Achievement[]
  fetchedAt: number
}

export type AchievementsResult =
  | { status: 'ok'; data: GameAchievements }
  /** Identifiant ou clé RetroAchievements non renseignés dans les paramètres. */
  | { status: 'noKey' }
  /** La console n'a pas de succès. */
  | { status: 'unsupported' }
  /** Jeu introuvable sur RetroAchievements (ou sans succès). */
  | { status: 'noMatch' }
  | { status: 'error'; error: string }
