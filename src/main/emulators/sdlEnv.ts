// Émulateurs dont les liaisons manette dépendent du pilote SDL qui expose la manette : SDL choisit seul le pilote (HIDAPI, Raw Input, Windows.Gaming.Input ou XInput) et
// chacun donne à la même manette un autre GUID et une autre numérotation de boutons. Les profils de RomVault pour ces émulateurs visent la manette XInput (voir
// `applyEdenPad` : GUID reconstruit depuis le VID/PID réel ; `MELONDS_JOYSTICK` : indices du joystick brut XInput). On impose donc le pilote XInput pour que le résultat
// ne dépende ni de la version de SDL ni de la machine. Les autres émulateurs (Azahar : API GameController, DuckStation/PCSX2 : `SDL-0`, PPSSPP, RetroArch, Vita3K) lisent
// les manettes par leur mapping SDL standard et n'en ont pas besoin.
const XINPUT_ONLY = new Set(['eden', 'melonds'])

/** Variables d'environnement du processus de l'émulateur `id` (`undefined` : celles de RomVault, inchangées). */
export const emulatorEnv = (id: string): NodeJS.ProcessEnv | undefined =>
  XINPUT_ONLY.has(id) ? { ...process.env, SDL_JOYSTICK_HIDAPI: '0', SDL_JOYSTICK_RAWINPUT: '0', SDL_JOYSTICK_WGI: '0' } : undefined
