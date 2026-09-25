/**
 * Consoles du catalogue = celles prises en charge par un émulateur prévu (voir SUMMARY du projet).
 * `dat` : source du catalogue. Libretro (no-intro/redump) ; « igdb » pour la Switch, absente de Libretro (nécessite une clé IGDB).
 * PS4 est exclue.
 */
export interface ConsoleDef {
  id: string
  label: string
  /** Nom Libretro du système (dossier des DAT et des vignettes). */
  system: string
  dat: 'no-intro' | 'redump' | 'igdb'
  /** Nom du DAT principal s'il diffère de `system` (ex. Wii U : seul le DAT « Digital » existe). */
  datName?: string
  /** Constructeur, pour regrouper les filtres. */
  maker: 'Nintendo' | 'Sony'
  /** Identifiants de la plateforme chez IGDB et TheGamesDB. */
  igdb: number
  tgdb: number
}

export const MAKERS = ['Nintendo', 'Sony'] as const

export const CONSOLES: readonly ConsoleDef[] = [
  { id: 'nes', label: 'NES', system: 'Nintendo - Nintendo Entertainment System', dat: 'no-intro', maker: 'Nintendo', igdb: 18, tgdb: 7 },
  { id: 'snes', label: 'SNES', system: 'Nintendo - Super Nintendo Entertainment System', dat: 'no-intro', maker: 'Nintendo', igdb: 19, tgdb: 6 },
  { id: 'n64', label: 'N64', system: 'Nintendo - Nintendo 64', dat: 'no-intro', maker: 'Nintendo', igdb: 4, tgdb: 3 },
  { id: 'gb', label: 'Game Boy', system: 'Nintendo - Game Boy', dat: 'no-intro', maker: 'Nintendo', igdb: 33, tgdb: 4 },
  { id: 'gbc', label: 'Game Boy Color', system: 'Nintendo - Game Boy Color', dat: 'no-intro', maker: 'Nintendo', igdb: 22, tgdb: 41 },
  { id: 'gba', label: 'GBA', system: 'Nintendo - Game Boy Advance', dat: 'no-intro', maker: 'Nintendo', igdb: 24, tgdb: 5 },
  { id: 'nds', label: 'DS', system: 'Nintendo - Nintendo DS', dat: 'no-intro', maker: 'Nintendo', igdb: 20, tgdb: 8 },
  { id: 'n3ds', label: '3DS', system: 'Nintendo - Nintendo 3DS', dat: 'no-intro', maker: 'Nintendo', igdb: 37, tgdb: 4912 },
  { id: 'gc', label: 'GameCube', system: 'Nintendo - GameCube', dat: 'redump', maker: 'Nintendo', igdb: 21, tgdb: 2 },
  { id: 'wii', label: 'Wii', system: 'Nintendo - Wii', dat: 'redump', maker: 'Nintendo', igdb: 5, tgdb: 9 },
  { id: 'wiiu', label: 'Wii U', system: 'Nintendo - Wii U', dat: 'no-intro', datName: 'Nintendo - Wii U (Digital)', maker: 'Nintendo', igdb: 41, tgdb: 38 },
  { id: 'switch', label: 'Switch', system: 'Nintendo - Switch', dat: 'igdb', maker: 'Nintendo', igdb: 130, tgdb: 4971 },
  { id: 'ps1', label: 'PS1', system: 'Sony - PlayStation', dat: 'redump', maker: 'Sony', igdb: 7, tgdb: 10 },
  { id: 'ps2', label: 'PS2', system: 'Sony - PlayStation 2', dat: 'redump', maker: 'Sony', igdb: 8, tgdb: 11 },
  { id: 'ps3', label: 'PS3', system: 'Sony - PlayStation 3', dat: 'redump', maker: 'Sony', igdb: 9, tgdb: 12 },
  { id: 'psp', label: 'PSP', system: 'Sony - PlayStation Portable', dat: 'no-intro', maker: 'Sony', igdb: 38, tgdb: 13 },
  { id: 'vita', label: 'PS Vita', system: 'Sony - PlayStation Vita', dat: 'no-intro', maker: 'Sony', igdb: 46, tgdb: 39 }
]

export const consoleById = (id: string): ConsoleDef | undefined => CONSOLES.find((c) => c.id === id)
