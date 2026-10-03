import type { InstallOutcome } from '../../library/content/types'

/** Contenu rattaché à un jeu (ligne de `library_content`) tel que l'installateur le voit. */
export interface ContentRef {
  id: number
  kind: 'update' | 'dlc'
  /** Fichier (ou dossier, Wii U) rangé par RomVault ; c'est lui que l'émulateur doit finir par voir. */
  path: string
  titleId: string | null
  version: string | null
  needs: string | null
  /** Quand RomVault l'a marqué installé (ms) ; renseigné pour les contenus « frères » d'une désinstallation. */
  installedAt?: number | null
}

/** Contenu à retirer de l'émulateur : le contenu lui-même plus ce que l'émulateur a créé pour lui (`emuFiles`, null pour un contenu installé avant ce suivi). */
export interface UninstallRef extends ContentRef {
  /**
   * `null` = installé avant le suivi des fichiers (provenance à établir par l'installateur, jamais supposée) ; un tableau = ce que l'installation a réellement CRÉÉ côté
   * émulateur (déjà débarrassé des fichiers partagés avec d'autres contenus) ; `[]` = rien n'appartient à RomVault (déjà présent avant, ou rien d'écrit côté émulateur).
   */
  emuFiles?: string[] | null
  /** Quand RomVault a marqué ce contenu installé (ms) : sert à prouver, pour un contenu sans suivi, que ce qui est dans l'émulateur date de cette installation. */
  installedAt?: number | null
  /** Les AUTRES contenus de ce jeu déjà installés : un installateur sans suivi s'en sert pour ne jamais retirer ce qu'ils partagent avec celui-ci. */
  siblings?: ContentRef[]
  /** Originaux sauvegardés avant que l'installation ne les réécrive : cible → copie. À remettre en place, pas à supprimer. */
  emuBackups?: Record<string, string> | null
}

/** `leftover` : quelque chose est resté côté émulateur (impossible à retirer proprement) — dit à l'utilisateur, jamais silencieux. */
export interface UninstallOutcome {
  ok: boolean
  detail?: string
  leftover?: string
  /** Chemins retirés de l'espace de l'émulateur : les autres contenus du jeu qui en dépendent sont remis en attente (réinstallés au prochain lancement). */
  removed?: string[]
}

export interface GameRef { id: number; console: string; title: string; path: string; baseKey: string }

export interface InstallEnv {
  /** Dossier des ROM gérées (`<roms>/<console>/.content/` y héberge les contenus). */
  romsDir: string
  /** Émulateur installé dans RomVault ; null sinon. */
  emulator: { dir: string; exe: string } | null
  /** L'exécutable (nom d'image Windows) tourne-t-il ? */
  isRunning: (image: string) => Promise<boolean>
}

/**
 * Stratégie d'installation propre à un émulateur : rend un contenu rattaché VISIBLE de l'émulateur par le mécanisme que celui-ci prévoit (jamais
 * « copier un fichier quelque part en espérant »). Idempotente : rappelée sur un contenu déjà installé, elle le constate sans rien refaire de destructeur.
 * `when` : `import` (silencieux, pendant l'import) ou `launch` (juste avant de lancer le jeu : les installations qui ouvrent la fenêtre de l'émulateur y sont permises).
 */
export interface ContentInstaller {
  emulatorId: string
  /** Vrai si le contenu doit être rangé par RomVault sous `<roms>/<console>/.content/` même en mode « ne pas copier » (l'émulateur le lit dans un dossier configuré). */
  managed: boolean
  install(env: InstallEnv, item: ContentRef, game: GameRef, when: 'import' | 'launch'): Promise<InstallOutcome>
  /**
   * Retire de l'émulateur ce que `install` y a mis (jamais le fichier rangé par RomVault : c'est `uninstallContent` qui s'en charge). Absente = rien n'est
   * installé dans l'émulateur (Eden lit le dossier géré, Cemu/Vita3K n'installent pas encore). `ok: false` = échec (émulateur ouvert…) : le contenu est conservé.
   */
  uninstall?(env: InstallEnv, items: UninstallRef[], game: GameRef): Promise<UninstallOutcome | void>
}
