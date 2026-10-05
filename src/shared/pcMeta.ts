import type { GameDetails } from './catalog'
import type { GameMedia } from './media'

/**
 * Fiche d'un jeu PC (exécutable ajouté ou jeu de launcher) identifié sur IGDB. Ces données sont l'ORIGINE affichée sous les surcharges de l'utilisateur
 * (shared/overrides.ts) : comme la fiche du catalogue pour une ROM, elles ne contiennent rien que l'utilisateur ait modifié.
 */
export interface PcMetaView {
  /** Nom du jeu chez IGDB (peut différer du titre de la bibliothèque, qui reste l'identité de l'entrée). */
  name: string
  details: Pick<GameDetails, 'summary' | 'developer' | 'releaseYear' | 'genres'>
  media: GameMedia | null
  /** Faux : aucune correspondance trouvée (la recherche sera retentée plus tard ou à la demande). */
  matched: boolean
}

/** Titre à chercher : sans marques déposées, éditions, parenthèses et tirets d'extension (« Jeu - Demo », « Jeu™ (Steam Edition) » → « Jeu »). */
export function pcSearchTerm(title: string): string {
  return title
    .replace(/[™®©]/g, ' ')
    .replace(/\s*[([].*?[)\]]/g, ' ')
    .replace(/\s+-\s+(demo|beta|playtest|early access|game of the year edition|goty edition|definitive edition|complete edition|deluxe edition)\b.*$/i, '')
    .replace(/\b(demo|playtest)\s*$/i, '')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
