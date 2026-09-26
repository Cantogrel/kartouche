export interface BackupInfo {
  /** Nom du fichier de sauvegarde (unique dans son dossier). */
  name: string
  at: number
  size: number
}

/**
 * Données de sauvegarde d'un jeu. `scope` : `game` = fichiers propres au jeu (RetroArch, melonDS) ;
 * `emulator` = l'émulateur range toutes ses sauvegardes ensemble (cartes mémoire, états…), la copie couvre donc tous ses jeux.
 */
export interface SaveInfo {
  emulator: string
  scope: 'game' | 'emulator'
  /** Nombre de fichiers de sauvegarde / d'états trouvés (0 = rien encore, ou emplacement inconnu). */
  files: number
  /** Dernière modification d'un de ces fichiers. */
  modified: number | null
  /** Dossier où se trouvent (ou se trouveront) ces fichiers. */
  location: string | null
  backups: BackupInfo[]
}

/** Nombre de copies conservées par jeu (ou par émulateur) : les plus anciennes sont supprimées. */
export const MAX_BACKUPS = 5
