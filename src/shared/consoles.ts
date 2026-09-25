/** Consoles du catalogue. `system` = nom Libretro (dossier des DAT et des vignettes). */
export interface ConsoleDef {
  id: string
  label: string
  system: string
  dat: 'no-intro' | 'redump'
}

export const CONSOLES: readonly ConsoleDef[] = [
  { id: 'nes', label: 'NES', system: 'Nintendo - Nintendo Entertainment System', dat: 'no-intro' },
  { id: 'snes', label: 'SNES', system: 'Nintendo - Super Nintendo Entertainment System', dat: 'no-intro' },
  { id: 'n64', label: 'N64', system: 'Nintendo - Nintendo 64', dat: 'no-intro' },
  { id: 'gb', label: 'Game Boy', system: 'Nintendo - Game Boy', dat: 'no-intro' },
  { id: 'gbc', label: 'Game Boy Color', system: 'Nintendo - Game Boy Color', dat: 'no-intro' },
  { id: 'gba', label: 'GBA', system: 'Nintendo - Game Boy Advance', dat: 'no-intro' },
  { id: 'nds', label: 'DS', system: 'Nintendo - Nintendo DS', dat: 'no-intro' },
  { id: 'n3ds', label: '3DS', system: 'Nintendo - Nintendo 3DS', dat: 'no-intro' },
  { id: 'gc', label: 'GameCube', system: 'Nintendo - GameCube', dat: 'redump' },
  { id: 'wii', label: 'Wii', system: 'Nintendo - Wii', dat: 'redump' },
  { id: 'genesis', label: 'Mega Drive', system: 'Sega - Mega Drive - Genesis', dat: 'no-intro' },
  { id: 'saturn', label: 'Saturn', system: 'Sega - Saturn', dat: 'redump' },
  { id: 'dreamcast', label: 'Dreamcast', system: 'Sega - Dreamcast', dat: 'redump' },
  { id: 'ps1', label: 'PS1', system: 'Sony - PlayStation', dat: 'redump' },
  { id: 'ps2', label: 'PS2', system: 'Sony - PlayStation 2', dat: 'redump' },
  { id: 'psp', label: 'PSP', system: 'Sony - PlayStation Portable', dat: 'no-intro' }
]

export const consoleById = (id: string): ConsoleDef | undefined => CONSOLES.find((c) => c.id === id)
