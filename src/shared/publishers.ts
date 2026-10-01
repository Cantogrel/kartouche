/**
 * Éditeur/développeur (filtre catalogue) : regroupement heuristique sur la colonne `developer` (venue des DAT
 * Libretro ou d'IGDB pour la Switch), pas une vraie donnée d'éditeur — le catalogue n'en a pas. Liste volontairement
 * courte, vérifiée contre le catalogue réel (2026-10-01, ~46 000 jeux hors variantes/doublons) : Tencent et Valve
 * étaient sous la barre des 10 résultats (jeux PC, quasi absents d'un catalogue de consoles) et ont été retirés.
 */
export interface PublisherDef {
  id: string
  label: string
  /** Sous-chaînes (insensibles à la casse) recherchées dans `developer` ; une seule suffit. */
  match: string[]
}

export const PUBLISHERS: PublisherDef[] = [
  { id: 'nintendo', label: 'Nintendo', match: ['Nintendo'] },
  { id: 'sony', label: 'Sony', match: ['Sony', 'Naughty Dog', 'Polyphony', 'Insomniac', 'Guerrilla', 'Sucker Punch', 'Santa Monica'] },
  { id: 'microsoft', label: 'Microsoft', match: ['Microsoft', 'Xbox Game Studios', '343 Industries', 'Rare', 'Bungie'] },
  { id: 'ea', label: 'Electronic Arts', match: ['Electronic Arts', 'EA Sports', 'BioWare', 'DICE'] },
  { id: 'rockstar', label: 'Rockstar', match: ['Rockstar'] }
]

/** Catégorie complémentaire : ni vide ni reconnu par un `PublisherDef` ci-dessus. */
export const PUBLISHER_OTHER = 'other'

export const publisherLabel = (id: string): string => PUBLISHERS.find((p) => p.id === id)?.label ?? id
