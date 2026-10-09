// Émulateurs dont les liaisons manette dépendent du pilote SDL qui expose la manette : SDL choisit seul le pilote (HIDAPI, Raw Input, Windows.Gaming.Input ou XInput) et
// chacun donne à la même manette un autre GUID et une autre numérotation de boutons. Les profils de Kartouche pour ces émulateurs visent la manette XInput (voir
// `applyEdenPad` : GUID reconstruit depuis le VID/PID réel ; `MELONDS_JOYSTICK` : indices du joystick brut XInput). On impose donc le pilote XInput pour que le résultat
// ne dépende ni de la version de SDL ni de la machine. Les autres émulateurs (Azahar : API GameController, DuckStation/PCSX2 : `SDL-0`, PPSSPP, RetroArch, Vita3K) lisent
// les manettes par leur mapping SDL standard et n'en ont pas besoin.
const XINPUT_ONLY = new Set(['eden', 'melonds'])

/** Variables d'environnement du processus de l'émulateur `id` (`undefined` : celles de Kartouche, inchangées). */
export const emulatorEnv = (id: string, nintendo = false, multi = false): NodeJS.ProcessEnv | undefined => {
  // RetroArch à plusieurs joueurs : une manette Xbox (XInput) doit rester visible à côté des manettes Nintendo (HIDAPI), sans les doublons DirectInput/Raw Input/WGI.
  if (nintendo && multi && id === 'retroarch') return { ...process.env, SDL_JOYSTICK_HIDAPI: '1', SDL_JOYSTICK_HIDAPI_XBOX: '0', SDL_JOYSTICK_RAWINPUT: '0', SDL_JOYSTICK_WGI: '0', SDL_DIRECTINPUT_ENABLED: '0', SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS: '1', SDL_JOYSTICK_HIDAPI_JOY_CONS: '1' }
  // Manette Nintendo principale d'un émulateur qui lit les joysticks bruts (melonDS) : le pilote HIDAPI (qui seul reconnaît la manette) et plus rien d'autre, pour que son rang soit celui
  // parmi les manettes Nintendo, sans les XInput ni DirectInput qui s'intercaleraient.
  // (RetroArch : la paire de Joy-Con est réunie en une manette, comme sous Dolphin.)
  if (nintendo && (id === 'melonds' || id === 'retroarch')) return { ...process.env, SDL_JOYSTICK_HIDAPI: '1', SDL_JOYSTICK_HIDAPI_XBOX: '0', SDL_JOYSTICK_RAWINPUT: '0', SDL_JOYSTICK_WGI: '0', SDL_XINPUT_ENABLED: '0', SDL_DIRECTINPUT_ENABLED: '0', SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS: '1', SDL_JOYSTICK_HIDAPI_JOY_CONS: '1' }
  // Azahar (SDL 2.32) et Cemu (SDL 2.30) : on garde leurs pilotes, mais la paire de Joy-Con est réunie en une seule manette.
  if (nintendo && (id === 'azahar' || id === 'cemu')) return { ...process.env, SDL_JOYSTICK_HIDAPI_JOY_CONS: '1', SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS: '1' }
  return XINPUT_ONLY.has(id) ? { ...process.env, SDL_JOYSTICK_HIDAPI: '0', SDL_JOYSTICK_RAWINPUT: '0', SDL_JOYSTICK_WGI: '0' } : undefined
}
