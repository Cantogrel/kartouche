/**
 * Jeu principal / mise à jour / DLC : modèle commun à toutes les consoles qui ont cette notion (Switch, 3DS, PS3, Wii U, Vita).
 * Chaque plateforme fournit une `ContentProbe` (lit l'identifiant NATIF dans le fichier) et, côté émulateur, un `ContentInstaller`
 * (voir emulators/content/) — le pipeline d'import (importer.ts) ne connaît que ces interfaces.
 */
/** `unknown` : identifiable comme contenu mais pas de façon fiable (identifiants contradictoires, format hors périmètre) — jamais importé ni rattaché. */
export type ContentKind = 'base' | 'update' | 'dlc' | 'unknown'

/** Origine de l'identification : `container` = métadonnées internes du format (fiable) ; `filename` = déduit du nom du fichier (repli). */
export type ContentSource = 'container' | 'filename'

export interface ContentInfo {
  console: string
  kind: ContentKind
  /** Identifiant natif du contenu lui-même (Title ID 16 hex majuscules, ou numéro de série PS3/Vita). */
  titleId: string
  /**
   * Identifiant natif du JEU PARENT : même valeur que `library.title_id` du jeu de base. Pour un jeu de base, c'est son propre
   * identifiant. Vide = le parent ne peut pas être déterminé (le contenu ne sera jamais rattaché par devinette).
   */
  baseKey: string
  /** Version du contenu (affichée telle quelle) ; null si inconnue. */
  version: string | null
  source: ContentSource
  /**
   * Précision utile à l'installation/à l'affichage (ex. « licence requise »). Jamais une information inventée : seulement ce que le fichier
   * lui-même déclare.
   */
  needs?: 'license'
  /** Nom court lisible du contenu, quand le format en porte un. */
  label?: string
  /** Pourquoi le contenu est `unknown` (journal et message d'import). */
  reason?: string
}

/** Éléments dont une sonde peut avoir besoin et qui ne viennent pas du fichier. */
export interface ProbeContext {
  /** Chemin d'un `prod.keys` (Switch) : déchiffre l'en-tête des NCA de métadonnées. Absent = on retombe sur les repères non chiffrés. */
  switchKeysFile?: string
}

/** Résultat d'un contenu mis en attente côté émulateur (voir `ContentInstaller`). */
export type ContentState = 'installed' | 'pending' | 'failed'

/**
 * Raison d'une mise en attente : `emulatorMissing` (pas encore installé dans RomVault), `emulatorRunning` (l'émulateur tourne et réécrirait sa
 * configuration), `onLaunch` (l'installation passe par l'émulateur lui-même, déclenchée au prochain lancement du jeu), `needsKey` (une clé fournie
 * par l'utilisateur manque : zRIF, licence…), `unsupported` (installation pas encore implémentée pour ce format), `error` (échec, nouvelle tentative possible).
 */
export type PendingReason = 'emulatorMissing' | 'emulatorRunning' | 'onLaunch' | 'needsKey' | 'unsupported' | 'error'

export interface InstallOutcome {
  state: ContentState
  reason?: PendingReason
  detail?: string
  /** Chemins (absolus) créés par l'émulateur dans son propre espace pour ce contenu : mémorisés pour pouvoir le désinstaller proprement. */
  emuFiles?: string[]
  /** Fichiers de l'émulateur que l'installation a réécrits : cible → copie de sauvegarde de l'original (restaurée à la désinstallation). */
  emuBackups?: Record<string, string>
}
