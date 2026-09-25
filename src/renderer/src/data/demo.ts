export interface DemoGame {
  id: string; title: string; console: string; genres: string[]; year: number
  publisher: string; developer: string; description: string
  inLibrary: boolean; hasFile: boolean; playMinutes: number; lastPlayedDays: number | null; progress?: number
}

const g = (id: string, title: string, console: string, genres: string[], year: number, publisher: string, developer: string,
  inLibrary: boolean, hasFile: boolean, playMinutes = 0, lastPlayedDays: number | null = null, progress?: number): DemoGame => ({
  id, title, console, genres, year, publisher, developer, inLibrary, hasFile, playMinutes, lastPlayedDays, progress,
  description: `${title} (${console}, ${year}) : fiche de démonstration. Les vraies fiches viendront des sources de données (Phase 3).`
})

export const DEMO_GAMES: DemoGame[] = [
  g('smw', 'Super Mario World', 'SNES', ['Platformer'], 1990, 'Nintendo', 'Nintendo EAD', true, true, 240, 3, 42),
  g('mp', 'Metroid Prime', 'GameCube', ['Action', 'Adventure'], 2002, 'Nintendo', 'Retro Studios', true, true, 95, 18, 10),
  g('ff7', 'Final Fantasy VII', 'PS1', ['RPG'], 1997, 'Sony', 'Square', true, false),
  g('oot', 'The Legend of Zelda: Ocarina of Time', 'N64', ['Adventure'], 1998, 'Nintendo', 'Nintendo EAD', true, true, 610, 1, 78),
  g('gow', 'God of War', 'PS2', ['Action', 'Adventure'], 2005, 'Sony', 'Santa Monica Studio', false, false),
  g('sotc', 'Shadow of the Colossus', 'PS2', ['Action', 'Adventure'], 2005, 'Sony', 'Team Ico', false, false),
  g('pkmn', 'Pokémon Emerald', 'GBA', ['RPG'], 2004, 'Nintendo', 'Game Freak', true, true, 1520, 6, 55),
  g('mk', 'Mario Kart Wii', 'Wii', ['Racing'], 2008, 'Nintendo', 'Nintendo EAD', false, false),
  g('dq', 'Dragon Quest VIII', 'PS2', ['RPG'], 2004, 'Square Enix', 'Level-5', false, false),
  g('botw', 'The Legend of Zelda: Breath of the Wild', 'Wii U', ['Adventure'], 2017, 'Nintendo', 'Nintendo EPD', false, false)
]

export const CONSOLES = ['NES', 'SNES', 'N64', 'GameCube', 'Wii', 'GBA', 'DS', '3DS', 'Wii U', 'Switch', 'PS1', 'PS2', 'PS3', 'PSP', 'PS Vita']
export const GENRES = ['Action', 'Adventure', 'Platformer', 'Racing', 'RPG']

export interface DemoEmulator { id: string; name: string; consoles: string; status: 'installed' | 'notInstalled' | 'setup'; version?: string }
export const DEMO_EMULATORS: DemoEmulator[] = [
  { id: 'retroarch', name: 'RetroArch', consoles: 'NES, SNES, GB, GBC, GBA, N64', status: 'installed', version: 'v1.22.2' },
  { id: 'duckstation', name: 'DuckStation', consoles: 'PlayStation 1', status: 'setup' },
  { id: 'pcsx2', name: 'PCSX2', consoles: 'PlayStation 2', status: 'notInstalled' },
  { id: 'rpcs3', name: 'RPCS3', consoles: 'PlayStation 3', status: 'notInstalled' },
  { id: 'ppsspp', name: 'PPSSPP', consoles: 'PSP', status: 'notInstalled' },
  { id: 'dolphin', name: 'Dolphin', consoles: 'GameCube, Wii', status: 'setup' },
  { id: 'melonds', name: 'melonDS', consoles: 'Nintendo DS', status: 'notInstalled' }
]
