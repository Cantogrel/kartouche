import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cemuProfileXml, cemuSettingsXml, writeCemuProfiles } from './cemu'
import { DEFAULT_GPU, type Gpu } from './gpu'
import { RETROARCH_CORE_CONFIG, retroarchAudio, retroarchVideo } from './retroarch'
import { DUCKSTATION_GAME_OVERRIDES, duckstationGpu } from './duckstation'
import { RPCS3_GAME_OVERRIDES, isRomvaultInput, rpcs3ConfigYaml, rpcs3InputYaml, type PadKind } from './rpcs3'
import { PPSSPP_GAME_OVERRIDES, expandXInputPads, ppssppGraphics } from './ppsspp'
import { vita3kRenderer } from './vita3k'
import { PCSX2_GAME_OVERRIDES, PCSX2_PROFILE_NAMES, pcsx2Gs, type Ps2Game } from './pcsx2'
import { AZAHAR_AUDIO, AZAHAR_GAME_OVERRIDES, AZAHAR_LAYOUT, azaharRenderer } from './azahar'
import { MELONDS_GAME_SCREENS, MELONDS_JOYSTICK, MELONDS_KEYBOARD, MELONDS_WINDOW, melondsRendering, planMelondsGame, tomlSection, type LayoutState, type ScreenOverride } from './melonds'
import { EDEN_GAME_OVERRIDES, EDEN_KEYBOARD_PROFILE, edenBackend, edenResolution } from './eden'
import { edenNintendoKeys, edenNintendoProfile, isNintendoButtonA, type EdenNintendo } from './edenPads'
import { dolphinGcPad, dolphinGraphics, dolphinNintendoGcPad, dolphinNintendoWiimote, dolphinWiimote, isUntouchedWiimoteFile, wiimoteKindFor, type DolphinNintendo } from './dolphin'

/** Ce dont la configuration automatique a besoin : langue de l'app, taille de l'écran, dossier de BIOS de l'émulateur. */
export interface ConfigContext {
  lang: 'en' | 'fr'
  /** Hauteur de l'écran principal en pixels physiques. */
  displayHeight: number
  biosDir: string
  /** GPU détecté (Cemu, Dolphin, RetroArch, Eden, voir `detectGpu`) : choisit Vulkan/OpenGL. */
  gpu?: Gpu
  /** Eden : le binaire connaît l'énumération de résolution récente (voir `hasQuarterResolutions`). Absent = récente. */
  edenNewResolutions?: boolean
}

/** 1 = jusqu'à 1080p (défaut), 2 = 1440p, 3 = 4K et plus. Sert à choisir la résolution interne de rendu. */
export const resolutionTier = (displayHeight: number): 1 | 2 | 3 => (displayHeight >= 2160 ? 3 : displayHeight >= 1440 ? 2 : 1)

/** Une valeur = une ligne ; un tableau = la clé répétée (plusieurs liaisons de touches ou de manette, format DuckStation/PCSX2). */
type IniValue = string | number | boolean | readonly string[]
type IniPatch = Record<string, Record<string, IniValue>>

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Fusionne des réglages dans un fichier .ini existant (ou vide) : les clés présentes sont mises à jour, les absentes ajoutées,
 * tout le reste (autres sections, commentaires, réglages de l'utilisateur) est conservé. `sep` : « = » ou « = » sans espaces (style Qt).
 */
export function patchIni(text: string, patch: IniPatch, sep = ' = '): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  for (const [section, keys] of Object.entries(patch)) {
    let start = lines.findIndex((l) => l.trim() === `[${section}]`)
    if (start === -1) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('')
      lines.push(`[${section}]`)
      start = lines.length - 1
    }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[.*\]\s*$/.test(l))
    if (end === -1) end = lines.length
    for (const [key, raw] of Object.entries(keys)) {
      const values = Array.isArray(raw) ? (raw as readonly string[]).map(String) : [String(raw)]
      const re = new RegExp(String.raw`^(\s*${escRe(key)}\s*=\s*).*$`)
      const at: number[] = []
      for (let i = start + 1; i < end; i++) if (re.test(lines[i])) at.push(i)
      if (at.length === values.length) { at.forEach((i, n) => { lines[i] = lines[i].replace(re, (_m, g1: string) => g1 + values[n]) }); continue }
      // Nombre de lignes différent : on remplace toutes les lignes de la clé, à la place de la première (sinon en fin de section).
      let ins = at.length ? at[0] : end
      if (!at.length) while (ins - 1 > start && lines[ins - 1].trim() === '') ins--
      for (let k = at.length - 1; k >= 0; k--) lines.splice(at[k], 1)
      end -= at.length
      lines.splice(ins, 0, ...values.map((v) => `${key}${sep}${v}`))
      end += values.length
    }
  }
  return lines.join(nl) + (lines.length && lines[lines.length - 1] !== '' ? nl : '')
}

/** Retire une section (« [nom] » et ses lignes) d'un .ini, le reste du fichier est conservé. */
function dropIniSection(text: string, section: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const l of lines) {
    if (/^\s*\[.*\]\s*$/.test(l)) skipping = l.trim() === `[${section}]`
    if (!skipping) out.push(l)
  }
  return out.join(text.includes('\r\n') ? '\r\n' : '\n')
}

/** Fichier plat `clé = "valeur"` de RetroArch. */
export function patchCfg(text: string, patch: Record<string, string | number | boolean>): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.replace(/(\r?\n)+$/, '').split(/\r?\n/)
  for (const [key, value] of Object.entries(patch)) {
    const re = new RegExp(`^\\s*${escRe(key)}\\s*=`)
    const line = `${key} = "${value}"`
    const at = lines.findIndex((l) => re.test(l))
    if (at !== -1) lines[at] = line
    else lines.push(line)
  }
  return lines.join(nl) + nl
}

async function readText(file: string): Promise<string> {
  return existsSync(file) ? readFile(file, 'utf8') : ''
}

async function writeIni(file: string, patch: IniPatch, sep?: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, patchIni(await readText(file), patch, sep))
}

/** Crée un fichier seulement s'il n'existe pas (YAML, TOML, XML : pas de fusion, on ne touche pas à un fichier existant). */
async function createOnce(file: string, content: string): Promise<void> {
  if (existsSync(file)) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

/** Réglage Qt « clé\default=false » + « clé=valeur » (Azahar, Eden). */
const qt = (o: Record<string, string | number | boolean>): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(o)) { out[`${k}\\default`] = false; out[k] = v }
  return out
}

/**
 * Met entre guillemets les valeurs qui contiennent une virgule. Qt (QSettings) lit une valeur non guillemetée à virgules comme une LISTE ; Azahar
 * l'attend en texte et, sinon, retombe sur sa valeur par défaut (constaté : les liaisons de manette redevenaient des touches de clavier dès le
 * premier démarrage d'Azahar). C'est aussi ce qu'Azahar écrit lui-même.
 */
const quoteLists = <T extends string | number | boolean>(o: Record<string, T>): Record<string, T | string> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && v.includes(',') && !v.startsWith('"') ? `"${v}"` : v]))

const pick = <T>(tier: 1 | 2 | 3, values: readonly [T, T, T]): T => values[tier - 1]

/** Fusionne des clés dans une section TOML (« [section] ») existante ou absente, sans toucher au reste du fichier. */
export function setTomlKeys(text: string, section: string, values: Record<string, string | number | boolean>): string {
  const fmt = (v: string | number | boolean): string => (typeof v === 'string' ? JSON.stringify(v) : String(v))
  const lines = text.split(/\r?\n/)
  const head = lines.findIndex((l) => l.trim() === `[${section}]`)
  if (head < 0) return `${text.replace(/\s*$/, '')}\n\n[${section}]\n${Object.entries(values).map(([k, v]) => `${k} = ${fmt(v)}`).join('\n')}\n`
  let end = lines.findIndex((l, i) => i > head && /^\s*\[/.test(l))
  if (end < 0) end = lines.length
  for (const [k, v] of Object.entries(values)) {
    const at = lines.findIndex((l, i) => i > head && i < end && new RegExp(`^\\s*${k}\\s*=`).test(l))
    if (at >= 0) lines[at] = `${k} = ${fmt(v)}`
    else { lines.splice(end, 0, `${k} = ${fmt(v)}`); end++ }
  }
  return lines.join('\n')
}

/** Change des valeurs de premier niveau d'un YAML (« clé: valeur ») en gardant tout le reste. */
export function patchYaml(text: string, patch: Record<string, string | number | boolean>): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.replace(/(\r?\n)+$/, '').split(/\r?\n/)
  for (const [key, value] of Object.entries(patch)) {
    const re = new RegExp(String.raw`^${escRe(key)}:`)
    const at = lines.findIndex((l) => re.test(l))
    if (at !== -1) lines[at] = `${key}: ${value}`
    else lines.push(`${key}: ${value}`)
  }
  return lines.join(nl) + nl
}

/** Lance un programme le temps qu'il crée ses fichiers de configuration (jusqu'à 20 s), puis le referme. */
async function runOnceUntil(exe: string, cwd: string, ready: () => boolean): Promise<void> {
  if (!existsSync(exe)) return
  const child = spawn(exe, [], { cwd, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  for (let i = 0; i < 40 && !ready(); i++) await new Promise((r) => setTimeout(r, 500))
  await new Promise((r) => setTimeout(r, 700))
  child.kill()
  await new Promise((r) => setTimeout(r, 500))
}

// --- Dolphin -------------------------------------------------------------------------------------------------------------

/**
 * Vrai si le fichier de manette GameCube est absent, celui de Kartouche (bouton A = touche X, éventuellement suivie de la manette) ou un
 * état inutilisable (« Button A » sans périphérique alors que le périphérique par défaut est le clavier) : on peut alors le réécrire.
 */
export function isUntouchedPadFile(text: string): boolean {
  const a = /^\s*Buttons\/A\s*=\s*(.*?)\s*$/m.exec(text)
  if (!a) return true
  if (/^`X`(\s*\|.*)?$/.test(a[1])) return true
  if (a[1] === '`Button A`' && /^\s*Device\s*=\s*DInput\/\d+\/Keyboard Mouse\s*$/m.test(text)) return true
  // Profil Switch Pro / Joy-Con de Kartouche (manette SDL Nintendo par défaut, A sur le bouton de droite).
  return (a[1] === '`Button E`' || a[1] === '`Button S`') && /^\s*Device\s*=\s*SDL\/\d+\/Nintendo Switch /m.test(text)
}

/**
 * Écrit les liaisons clavier + manette de Dolphin. Appelé au lancement d'un jeu avec la manette XInput branchée (ou null) : les
 * réglages faits à la main par l'utilisateur ne sont pas touchés (on ne réécrit un fichier que s'il porte encore la touche A écrite
 * par Kartouche). `game` : console du jeu lancé (seul le fichier de CETTE console est écrit : manette GameCube pour un jeu GameCube,
 * Wiimote pour un jeu Wii, jamais l'un pour l'autre) et identifiant disque (extension de la Wiimote, voir `wiimoteKindFor`) ; sans
 * lui (installation), les deux fichiers sont écrits au clavier seul.
 */
export async function applyDolphinPad(dir: string, xinputSlot: number | null, game?: { console: string; gameId: string | null }, nintendo?: { kind: DolphinNintendo; port: number } | null): Promise<void> {
  const cfg = join(dir, 'User', 'Config')
  const device = xinputSlot === null ? null : `XInput/${xinputSlot}/Gamepad`
  const gcFile = join(cfg, 'GCPadNew.ini')
  const wiiFile = join(cfg, 'WiimoteNew.ini')
  if (!game || game.console === 'gc') {
    if (isUntouchedPadFile(await readText(gcFile))) await writeIni(gcFile, nintendo && game && xinputSlot === null && nintendo.kind !== 'joycon-right' ? dolphinNintendoGcPad(nintendo.kind, nintendo.port) : dolphinGcPad(device))
  }
  if (!game || game.console === 'wii') {
    // À l'installation (sans `game`), le fichier créé par Dolphin lui-même n'est pas un réglage de l'utilisateur : toujours écrit.
    {
      const current = await readText(wiiFile)
      if (!game || isUntouchedWiimoteFile(current)) {
        // Section remplacée en entier (pas fusionnée) : les touches d'un profil précédent (Swing, Nunchuk, Classic…) ne doivent pas survivre au changement de profil.
        await mkdir(dirname(wiiFile), { recursive: true })
        const wiiKind = game ? wiimoteKindFor(game.gameId) : 'nunchuk'
        // Manette Nintendo principale (jamais avec une XInput : la règle d'avant ne change pas) : profil SDL avec gyroscope.
        await writeFile(wiiFile, patchIni(dropIniSection(current, 'Wiimote1'), nintendo && game && xinputSlot === null ? dolphinNintendoWiimote(nintendo.kind, nintendo.port, wiiKind) : dolphinWiimote(device, wiiKind)))
      }
    }
  }
}

/**
 * Active la journalisation fichier de DuckStation (idempotent, réappliqué à chaque lancement) : DuckStation n'écrit rien
 * sur la sortie standard, donc c'est le seul moyen de récupérer la raison d'un jeu qui se ferme sans se lancer (BIOS
 * refusé, SBI manquant, etc.) — voir `readLaunchLog` dans le lanceur.
 */
export async function ensureDuckstationLogging(dir: string): Promise<void> {
  await writeIni(join(dir, 'settings.ini'), { Logging: { LogLevel: 'Warning', LogToFile: true } })
}

/** Langue de la console Wii = octet « IPL.LNG » du fichier SYSCONF (0 JP, 1 EN, 2 DE, 3 FR, 4 ES, 5 IT, 6 NL). */
export function setSysconfLanguage(data: Buffer, language: number): boolean {
  if (data.length < 8 || data.subarray(0, 4).toString('latin1') !== 'SCv0') return false
  const count = data.readUInt16BE(4)
  for (let i = 0; i < count; i++) {
    const off = data.readUInt16BE(6 + i * 2)
    const nameLen = (data[off] & 0x1f) + 1
    if (data.subarray(off + 1, off + 1 + nameLen).toString('latin1') === 'IPL.LNG') { data[off + 1 + nameLen] = language; return true }
  }
  return false
}

/** Lance Dolphin une seconde le temps qu'il crée son SYSCONF (réglages de la Wii), puis le referme. */
async function dolphinCreateSysconf(dir: string): Promise<string | null> {
  const sysconf = join(dir, 'User', 'Wii', 'shared2', 'sys', 'SYSCONF')
  const pads = [join(dir, 'User', 'Config', 'GCPadNew.ini'), join(dir, 'User', 'Config', 'WiimoteNew.ini')]
  if (existsSync(sysconf) && pads.every((f) => existsSync(f))) return sysconf
  await runOnceUntil(join(dir, 'Dolphin.exe'), dir, () => existsSync(sysconf) && pads.every((f) => existsSync(f)))
  return existsSync(sysconf) ? sysconf : null
}

// --- Azahar : langue de la console 3DS (binaire, dans le NAND émulé) + manette SDL ---------------------------------------

/**
 * Langue de la console 3DS : contrairement à l'appli (réglage texte `[UI] language`), c'est un bloc du fichier `config`
 * émulé du NAND (service CFG, bloc 0x000A0002 « LanguageBlockID ») — la même idée que SYSCONF pour la Wii, un format
 * différent. Structure (vérifiée sur un fichier réel) : u16 total_entries, u16 data_entries_offset, puis `total_entries`
 * entrées de 12 octets (u32 block_id, u32 offset_or_data, u16 size, u16 access_flags) ; un bloc de 4 octets ou moins loge
 * sa valeur directement dans `offset_or_data` (poids faible) plutôt qu'à un offset séparé — c'est le cas de la langue (1 octet).
 * 0 japonais, 1 anglais, 2 français, 3 allemand, 4 italien, 5 espagnol, 6 chinois simplifié, 7 coréen, 8 néerlandais, 9 portugais, 10 russe, 11 chinois traditionnel.
 */
export function setCfgLanguage(data: Buffer, language: number): boolean {
  if (data.length < 4) return false
  const totalEntries = data.readUInt16LE(0)
  for (let i = 0; i < totalEntries; i++) {
    const at = 4 + i * 12
    if (at + 12 > data.length) break
    if (data.readUInt32LE(at) === 0x000a0002 && data.readUInt16LE(at + 8) <= 4) { data.writeUInt8(language, at + 4); return true }
  }
  return false
}

/**
 * Chemin du fichier `config` du NAND émulé : n'existe qu'après qu'Azahar ait démarré au moins un jeu (le service CFG
 * s'initialise pendant le chargement d'un titre, pas au simple démarrage de l'appli — contrairement au SYSCONF de
 * Dolphin). On ne peut donc pas le créer à l'installation comme pour la Wii : la langue est patchée à chaque lancement
 * de jeu si le fichier existe déjà (voir `launcher.ts`), quitte à ce que le tout premier lancement reste en anglais.
 */
export const azaharCfgPath = (dir: string): string => join(dir, 'user', 'nand', 'data', '00000000000000000000000000000000', 'sysdata', '00010017', '00000000', 'config')

/** Bouton et axe SDL_GameController (indices de l'API publique SDL2, stables depuis sa création). */
const SDL_BUTTON: Record<string, number> = {
  A: 0, B: 1, X: 2, Y: 3, Back: 4, Start: 6, LeftStick: 7, RightStick: 8, L: 9, R: 10, Up: 11, Down: 12, Left: 13, Right: 14
}
const SDL_AXIS = { LeftX: 0, LeftY: 1, RightX: 2, RightY: 3, TriggerLeft: 4, TriggerRight: 5 }

// GUID SDL réservée à Windows pour « n'importe quel périphérique XInput » (couvre la quasi-totalité des manettes utilisées
// sur PC) : SDL2 la documente comme fixe, indépendante du matériel réel — https://wiki.libsdl.org/SDL2/SDL_GameControllerAddMapping.
// `maptype:all` fait en plus répondre à n'importe quel port, donc aucune détection n'est nécessaire au lancement,
// contrairement à Dolphin dont le format de liaison exige un index XInput explicite. Format vérifié contre le générateur
// de RetroBat pour Azahar (emulatorLauncher/Generators/Azahar.Controllers.cs, en usage réel) : ni GUID vide ni champ
// `api` superflu — une valeur `guid` vide fait qu'Azahar rejette silencieusement la liaison et revient au clavier par défaut.
const XINPUT_GUID = '78696e70757401000000000000000000'
// `api:controller` est indispensable : sans lui, Azahar lit des « joysticks » SDL bruts ET exige le GUID exact (`maptype:all` n'ignore le GUID que pour
// l'API controller — vérifié dans input_common/sdl/sdl_impl.cpp). Avec lui, les indices sont ceux de SDL_GameController (A, B, croix…) et n'importe quelle
// manette que SDL reconnaît répond, quel que soit son GUID (Xbox, DualSense, pad virtuel Sunshine/Moonlight).
const sdlButton = (button: number): string => `api:controller,button:${button},engine:sdl,guid:${XINPUT_GUID},maptype:all,port:0`
const sdlTrigger = (axis: number): string => `api:controller,axis:${axis},direction:+,threshold:0.5,engine:sdl,guid:${XINPUT_GUID},maptype:all,port:0`
const sdlAnalog = (axisX: number, axisY: number): string => `api:controller,axis_x:${axisX},axis_y:${axisY},deadzone:0.100000,engine:sdl,guid:${XINPUT_GUID},maptype:all,port:0`

/**
 * Second profil de manette d'Azahar (profil 1 = celui créé par Azahar lui-même au clavier, jamais touché) : boutons
 * croisés sur la position physique d'une manette Xbox (3DS A ↔ Xbox B, à droite ; 3DS Y ↔ Xbox X, à gauche), ZL/ZR sur
 * les gâchettes analogiques, sticks en direct (pas émulés depuis des boutons). Activé par défaut (`profile=1`) ; le
 * profil clavier d'origine reste disponible dans le sélecteur de profil d'Azahar.
 */
const AZAHAR_CONTROLLER_PROFILE: Record<string, string | number> = {
  'profiles\\2\\name': 'Manette',
  // InputMappingType : 0 = toutes les manettes (`maptype:all`), 1 = par GUID, 2 = par GUID et port. Azahar réécrit le `maptype` de chaque liaison
  // d'après cette valeur au chargement du profil : à 1, les liaisons exigeaient le GUID supposé ci-dessous et aucune vraie manette ne répondait.
  'profiles\\2\\input_maptype': 0,
  'profiles\\2\\button_a': sdlButton(SDL_BUTTON.B), 'profiles\\2\\button_b': sdlButton(SDL_BUTTON.A),
  'profiles\\2\\button_x': sdlButton(SDL_BUTTON.Y), 'profiles\\2\\button_y': sdlButton(SDL_BUTTON.X),
  'profiles\\2\\button_up': sdlButton(SDL_BUTTON.Up), 'profiles\\2\\button_down': sdlButton(SDL_BUTTON.Down),
  'profiles\\2\\button_left': sdlButton(SDL_BUTTON.Left), 'profiles\\2\\button_right': sdlButton(SDL_BUTTON.Right),
  // LT → L + ZL et RT → R + ZR : le même axe de gâchette est donné à deux boutons 3DS (chacun a son propre ParamPackage, rien ne l'interdit — vérifié
  // dans le code d'Azahar). LB/RB restent libres : un bouton 3DS n'accepte qu'une entrée, ils n'ont donc pas de rôle.
  'profiles\\2\\button_l': sdlTrigger(SDL_AXIS.TriggerLeft), 'profiles\\2\\button_r': sdlTrigger(SDL_AXIS.TriggerRight),
  'profiles\\2\\button_start': sdlButton(SDL_BUTTON.Start), 'profiles\\2\\button_select': sdlButton(SDL_BUTTON.Back),
  'profiles\\2\\button_zl': sdlTrigger(SDL_AXIS.TriggerLeft), 'profiles\\2\\button_zr': sdlTrigger(SDL_AXIS.TriggerRight),
  'profiles\\2\\button_home': sdlButton(SDL_BUTTON.LeftStick),
  'profiles\\2\\circle_pad': sdlAnalog(SDL_AXIS.LeftX, SDL_AXIS.LeftY),
  'profiles\\2\\c_stick': sdlAnalog(SDL_AXIS.RightX, SDL_AXIS.RightY),
  'profiles\\2\\motion_device': 'engine:motion_emu,update_period:100,sensitivity:0.01,tilt_clamp:90.0',
  'profiles\\2\\touch_device': 'engine:emu_window',
  // Tactile par bouton (en plus de la souris, qui garde la priorité : le service HID lit d'abord `touch_device`, puis ce repli) : voir `AZAHAR_TOUCH_BUTTONS`.
  'profiles\\2\\use_touch_from_button': 'true', 'profiles\\2\\touch_from_button_map': 0,
  'profiles\\2\\udp_input_address': '127.0.0.1', 'profiles\\2\\udp_input_port': 26760, 'profiles\\2\\udp_pad_index': 0
}

/**
 * Tactile par bouton, moteur natif d'Azahar (`touch_from_button`) : chaque entrée `bind` est la liaison d'un bouton (mêmes paramètres SDL que le profil) plus
 * la position `x`/`y` du « tap » en pixels de l'écran du bas (320 x 240, vérifié dans touch_from_button.cpp). LB = tap au milieu en hauteur, à 1/3 de la
 * gauche ; RB = au milieu en hauteur, à 1/3 de la droite. Les gâchettes avant ne servent plus à L/R (voir le profil) : elles tapent à l'écran. La souris reste
 * disponible : elle est lue en premier, le tactile par bouton n'est qu'un repli (hid.cpp). Le tableau est celui de la carte 1 (`touch_from_button_map=0`).
 */
const TOUCH_W = 320
const TOUCH_H = 240
const touchBind = (button: number, x: number): string => `"${sdlButton(button)},x:${Math.round(x)},y:${TOUCH_H / 2}"`
const AZAHAR_TOUCH_BUTTONS: Record<string, string | number> = {
  'touch_from_button_maps\\1\\entries\\1\\bind': touchBind(SDL_BUTTON.L, TOUCH_W / 3),
  'touch_from_button_maps\\1\\entries\\2\\bind': touchBind(SDL_BUTTON.R, (TOUCH_W * 2) / 3),
  'touch_from_button_maps\\1\\entries\\size': 2,
  // La liste des cartes elle-même : sans `touch_from_button_maps\size`, Azahar lit « 0 carte », ignore les entrées ci-dessus et réécrit `entries\size=0`
  // (constaté sur une installation propre, où ces clés n'existent pas encore).
  'touch_from_button_maps\\size': 1,
  'touch_from_button_maps\\1\\name': 'default'
}

// --- Eden : manette SDL (même GUID XInput générique qu'Azahar, mais format de Param différent — pas de `maptype`,
// `invert` au lieu de `direction`, pas de deadzone par liaison — vérifié contre le code source réel d'Eden :
// BuildButtonParamPackageForButton / BuildParamPackageForAnalog, src/input_common/drivers/sdl_driver.cpp). ------------
/**
 * GUID SDL d'une manette XInput : le pilote XInput de SDL (signature `x`) y met le VID/PID lus par XInputGetCapabilitiesEx. C'est exactement ce qu'Eden écrit
 * dans son qt-config.ini quand on lui désigne la manette à la main (ex. Xbox One : 045E:02FF → `030000005e040000ff02000000007801`).
 */
export function sdlXInputGuid(vid: number, pid: number, ver = 0): string {
  const le = (n: number): string => (n & 0xff).toString(16).padStart(2, '0') + ((n >> 8) & 0xff).toString(16).padStart(2, '0')
  return `03000000${le(vid)}0000${le(pid)}0000${le(ver)}7801`
}

/** Les « boutons » sont ceux de la manette vue comme joystick brut par le pilote XInput de SDL (et non ceux de l'API GameController) : c'est ce qu'Eden écrit lui-même. */
const edenButton = (guid: string, button: number): string => `engine:sdl,port:0,guid:${guid},button:${button}`
const edenHat = (guid: string, direction: string): string => `engine:sdl,port:0,guid:${guid},hat:0,direction:${direction}`
const edenTrigger = (guid: string, axis: number): string => `engine:sdl,port:0,guid:${guid},axis:${axis},threshold:0.5,invert:+`
const edenStick = (guid: string, axisX: number, axisY: number): string =>
  `engine:sdl,port:0,guid:${guid},axis_x:${axisX},axis_y:${axisY},offset_x:0,offset_y:0,invert_x:+,invert_y:+`

/**
 * Manette du joueur 1 pour la manette XInput de GUID `guid` (`port` désambiguïse plusieurs manettes au même GUID). Disposition identique à celle qu'Eden choisit
 * lui-même pour une manette Xbox : les boutons suivent les POSITIONS d'une console Switch (A = bouton de droite = B de la manette Xbox), la croix est un « hat »,
 * ZL/ZR les gâchettes analogiques, +/- sur Start/Back. Pas de liaison pour SL/SR, Home ni gyroscope : Eden garde les siens. Chaque clé nécessite sa liaison
 * `\default=false` (`qt()`) : `ReadStringSetting` ignore silencieusement la valeur écrite si ce marqueur est absent ou à `true` (src/frontend_common/config.cpp).
 * Joueur 1 connecté en Pro Controller par défaut, sans réglage à écrire (Config::ReadPlayerValues).
 */
function edenControllerProfile(guid: string): Record<string, string> {
  return {
    player_0_button_a: edenButton(guid, 1), player_0_button_b: edenButton(guid, 0),
    player_0_button_x: edenButton(guid, 3), player_0_button_y: edenButton(guid, 2),
    player_0_button_l: edenButton(guid, 4), player_0_button_r: edenButton(guid, 5),
    player_0_button_zl: edenTrigger(guid, 2), player_0_button_zr: edenTrigger(guid, 5),
    player_0_button_plus: edenButton(guid, 7), player_0_button_minus: edenButton(guid, 6),
    player_0_button_lstick: edenButton(guid, 8), player_0_button_rstick: edenButton(guid, 9),
    player_0_button_dup: edenHat(guid, 'up'), player_0_button_ddown: edenHat(guid, 'down'),
    player_0_button_dleft: edenHat(guid, 'left'), player_0_button_dright: edenHat(guid, 'right'),
    player_0_lstick: edenStick(guid, 0, 1), player_0_rstick: edenStick(guid, 3, 4)
  }
}

/**
 * Raccourci manette natif d'Azahar (`controller_keyseq` : une ou deux liaisons SDL séparées par « || », à maintenir ensemble) : clic du stick droit =
 * échanger les écrans (comme dans melonDS). Le champ est entre guillemets (valeur à virgules). Changer de disposition reste au clavier (F10) : aucun bouton
 * 3DS libre pour un second raccourci sans gêner les jeux.
 */
const hotkey = (...buttons: number[]): string => `"${buttons.map(sdlButton).join('||')}"`
const AZAHAR_CONTROLLER_HOTKEYS: Record<string, string> = {
  'Shortcuts\\Main%20Window\\Swap%20Screens\\controller_keyseq': hotkey(SDL_BUTTON.RightStick)
}

/**
 * Profil actif d'Azahar selon ce qui est branché, à chaque lancement : profil 2 (manette, `profile=1`) si une manette XInput est connectée, sinon
 * profil 1 (clavier, `profile=0`). Seulement tant que le profil 2 est encore celui de Kartouche et que le profil actif est l'un des deux : si
 * l'utilisateur a créé ou choisi un autre profil dans Azahar, rien n'est touché.
 */
export async function applyAzaharPad(dir: string, controllerConnected: boolean): Promise<void> {
  const file = join(dir, 'user', 'config', 'qt-config.ini')
  const text = await readText(file)
  if (!/^profiles\\2\\name=Manette\s*$/m.test(text)) return
  const buttonA = /^profiles\\2\\button_a=.*/m.exec(text)?.[0] ?? ''
  if (!buttonA.includes(XINPUT_GUID)) return
  const current = Number(/^profile=(\d+)\s*$/m.exec(text)?.[1] ?? 0)
  if (current > 1) return
  const wanted = controllerConnected ? 1 : 0
  // Profil écrit par une ancienne version de Kartouche (liaisons sans `api:controller` : aucune manette ne répondait) : remplacé par le profil actuel.
  // Seulement tant qu'il porte encore le GUID supposé : un profil refait dans Azahar par l'utilisateur n'est jamais touché.
  // (ou L encore sur le bouton LB d'avant : seule valeur précise remplacée, une autre liaison de L choisie par l'utilisateur reste intacte).
  const outdated = !buttonA.includes('api:controller') || /^profiles\\2\\button_l="api:controller,button:9,/m.test(text)
  if (outdated) await writeIni(file, { Controls: { ...qt(quoteLists(AZAHAR_CONTROLLER_PROFILE)), ...AZAHAR_TOUCH_BUTTONS } }, '=')
  // Tactile par bouton absent (installation d'avant cette fonction) : ajouté seulement si la carte est vide, donc jamais par-dessus un choix de l'utilisateur.
  else if (/^touch_from_button_maps\\1\\entries\\size=0\s*$/m.test(text)) {
    await writeIni(file, { Controls: { ...qt({ 'profiles\\2\\use_touch_from_button': 'true', 'profiles\\2\\touch_from_button_map': 0 }), ...AZAHAR_TOUCH_BUTTONS } }, '=')
  }
  // Ancien raccourci en combinaison (clic du stick droit + bas / + droite) : remplacé par le clic seul pour échanger les écrans ; l'autre est retiré.
  if (/^Shortcuts\\Main%20Window\\Swap%20Screens\\controller_keyseq=".*\|\|/m.test(text)) {
    await writeIni(file, { UI: { ...qt(AZAHAR_CONTROLLER_HOTKEYS), 'Shortcuts\\Main%20Window\\Toggle%20Screen%20Layout\\controller_keyseq\\default': true } }, '=')
  }
  if (current !== wanted || /^profile\\default=true\s*$/m.test(text)) await writeIni(file, { Controls: qt({ profile: wanted }) }, '=')
}

/** Configuration propre au jeu (Title ID) si l'exception est connue (voir `AZAHAR_GAME_OVERRIDES`) ; jamais d'un fichier déjà présent. */
export async function applyAzaharGameConfig(dir: string, titleId: string | null | undefined, table: Record<string, IniPatch> = AZAHAR_GAME_OVERRIDES): Promise<void> {
  const patch = titleId ? table[titleId.toUpperCase()] : undefined
  if (!patch) return
  const file = join(dir, 'user', 'config', 'custom', `${titleId!.toUpperCase()}.ini`)
  if (!existsSync(file)) await writeIni(file, patch, '=')
}

/**
 * Réglages DuckStation propres au jeu (numéro de série du disque), dans `gamesettings/<SERIE>.ini`, seulement si l'exception est connue (voir
 * `DUCKSTATION_GAME_OVERRIDES`) ; jamais d'un fichier déjà présent (créé par l'utilisateur dans DuckStation).
 */
export async function applyDuckstationGame(dir: string, serial: string | null | undefined, table: Record<string, IniPatch> = DUCKSTATION_GAME_OVERRIDES): Promise<void> {
  if (!serial) return
  const patch: IniPatch = { ...table[serial.toUpperCase()] }
  // Carte mémoire : par défaut DuckStation en donne une à chaque jeu (« PerGameTitle », nommée d'après son titre) et Kartouche la retrouve à son contenu (voir saves.ts).
  // Si l'utilisateur a choisi une carte PARTAGÉE entre tous les jeux, ce jeu reçoit la sienne (« PerGame », `<SERIE>_<slot>.mcd`) : sinon ses sauvegardes seraient mêlées à celles des autres.
  const settings = await readText(join(dir, 'settings.ini'))
  const shared = (slot: number): boolean => new RegExp(`^\\s*Card${slot}Type\\s*=\\s*Shared\\b`, 'mi').test(settings)
  const cards: Record<string, string> = {}
  if (shared(1)) cards.Card1Type = 'PerGame'
  if (shared(2)) cards.Card2Type = 'PerGame'
  if (Object.keys(cards).length) patch.MemoryCards = { ...cards, ...patch.MemoryCards }
  if (!Object.keys(patch).length) return
  const file = join(dir, 'gamesettings', `${serial.toUpperCase()}.ini`)
  if (!existsSync(file)) await writeIni(file, patch)
}

/**
 * Réglages PPSSPP propres au jeu (DISC_ID), dans `memstick/PSP/SYSTEM/<ID>_ppsspp.ini`, seulement si l'exception est connue (voir `PPSSPP_GAME_OVERRIDES`) ;
 * jamais d'un fichier déjà présent (créé par l'utilisateur dans PPSSPP).
 */
export async function applyPpssppGame(dir: string, discId: string | null | undefined, table: typeof PPSSPP_GAME_OVERRIDES = PPSSPP_GAME_OVERRIDES): Promise<void> {
  const patch = discId ? table[discId.toUpperCase()] : undefined
  if (!patch) return
  const file = join(dir, 'memstick', 'PSP', 'SYSTEM', `${discId!.toUpperCase()}_ppsspp.ini`)
  if (!existsSync(file)) await writeIni(file, patch)
}

/** Manettes XInput 0 à 3 de PPSSPP (`controls.ini`, créé par PPSSPP au premier lancement) : la manette utilisée n'est pas forcément la première (voir `expandXInputPads`). */
export async function applyPpssppPads(dir: string): Promise<void> {
  const file = join(dir, 'memstick', 'PSP', 'SYSTEM', 'controls.ini')
  const text = await readText(file)
  if (!text) return
  const next = expandXInputPads(text)
  if (next !== text) await writeFile(file, next)
}

/**
 * Passe une fois les installations existantes à la disposition hybride (écran principal en grand, les deux petits à côté) : melonDS (`ScreenLayout` 0 = naturelle → 3) et Azahar
 * (`layout_option` 2 = grand écran → 5). Seulement si la valeur est encore celle écrite par Kartouche avant ; un marqueur évite de revenir sur un choix fait ensuite.
 */
export async function migrateHybridLayout(id: 'melonds' | 'azahar', dir: string): Promise<void> {
  const marker = join(dir, 'kartouche-layout-hybrid')
  if (existsSync(marker)) return
  if (id === 'melonds') {
    const file = join(dir, 'melonDS.toml')
    const text = await readText(file)
    if (!text) return // pas encore configuré : l'installation écrira déjà l'hybride
    if (tomlSection(text, 'Instance0.Window0')['ScreenLayout'] === '0') await writeFile(file, setTomlKeys(text, 'Instance0.Window0', { ScreenLayout: 3 }))
  } else {
    const file = join(dir, 'user', 'config', 'qt-config.ini')
    const text = await readText(file)
    if (!text) return
    const next = text.replace(/^layout_option=2\s*$/m, 'layout_option=5')
    if (next !== text) await writeFile(file, next)
  }
  await writeFile(marker, '')
}

/**
 * Réglages PCSX2 propres au jeu (numéro de série + CRC de l'exécutable), dans `gamesettings/<SERIE>_<CRC>.ini`, seulement si l'exception est connue
 * (voir `PCSX2_GAME_OVERRIDES`) ; jamais d'un fichier déjà présent (créé par l'utilisateur dans PCSX2).
 */
export async function applyPcsx2Game(dir: string, game: Ps2Game | null, table: Record<string, IniPatch> = PCSX2_GAME_OVERRIDES): Promise<void> {
  const patch = game ? table[game.serial] : undefined
  if (!patch || !game) return
  const file = join(dir, 'gamesettings', `${game.serial}_${game.crc}.ini`)
  if (!existsSync(file)) await writeIni(file, patch)
}

/**
 * Profil de manette global de RPCS3 selon ce qui est branché, à chaque lancement : manette XInput (emplacement réel de la manette connectée, donc aussi le pad virtuel de
 * Sunshine/Moonlight), sinon manette Sony native, sinon clavier — le profil de Kartouche est alors retiré et RPCS3 retombe sur son pad clavier par défaut. Sans profil, RPCS3
 * n'utilise AUCUNE manette. Seulement tant que le fichier est absent ou porte le marqueur de Kartouche : un profil réglé dans RPCS3 par l'utilisateur n'est jamais touché.
 */
export async function applyRpcs3Pad(dir: string, pad: { kind: PadKind; slot?: number } | null): Promise<void> {
  const file = join(dir, 'config', 'input_configs', 'global', 'Default.yml')
  const text = existsSync(file) ? await readFile(file, 'utf8') : null
  if (!isRomvaultInput(text)) return
  if (!pad) { if (text !== null) await rm(file, { force: true }); return }
  const yaml = rpcs3InputYaml(pad.kind, pad.slot)
  if (text === null || text.replace(/\r\n/g, '\n') !== yaml) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, yaml)
  }
}

/**
 * Réglages RPCS3 propres au jeu (numéro de série) : configuration `custom_configs/config_<SERIE>.yml` et/ou profil de manette `input_configs/<SERIE>/Default.yml`, seulement
 * si l'exception est connue (voir `RPCS3_GAME_OVERRIDES`) ; jamais d'un fichier déjà présent (créé par l'utilisateur dans RPCS3).
 */
export async function applyRpcs3Game(dir: string, serial: string | null | undefined, table: typeof RPCS3_GAME_OVERRIDES = RPCS3_GAME_OVERRIDES): Promise<void> {
  const game = serial ? table[serial.toUpperCase()] : undefined
  if (!game || !serial) return
  const id = serial.toUpperCase()
  if (game.config) await createOnce(join(dir, 'config', 'custom_configs', `config_${id}.yml`), game.config)
  if (game.input) await createOnce(join(dir, 'config', 'input_configs', id, 'Default.yml'), game.input)
}

const edenConfig = (dir: string): string => join(dir, 'user', 'config', 'qt-config.ini')

/** Clé d'un réglage du joueur 1 (`player_0_…`) pour le joueur `player` (0 = joueur 1). */
const edenPlayerKey = (key: string, player: number): string => key.replace('player_0_', `player_${player}_`)

/** Les liaisons XInput du joueur `player`, pour la manette de GUID `guid` et de numéro `port` parmi les manettes de même GUID. */
function edenXInputKeys(guid: string, player: number, port: number): Record<string, string> {
  return Object.fromEntries(Object.entries(edenControllerProfile(guid)).map(([k, v]) => [edenPlayerKey(k, player), v.replace('port:0', `port:${port}`)]))
}

type EdenPlayerState = 'default' | 'xinput' | 'nintendo' | 'user'

/**
 * À qui appartiennent les touches du joueur `player` : à Eden (défaut), à Kartouche (profil XInput ou Nintendo) ou à l'utilisateur (configurées à la main : jamais touchées).
 * Les anciennes liaisons de Kartouche (GUID XInput générique, jamais reconnu par Eden) comptent comme les siennes.
 */
function edenPlayerState(text: string, player: number): EdenPlayerState {
  const key = edenPlayerKey('player_0_button_a', player)
  if (new RegExp(`^${key}\\\\default=true\\s*$`, 'm').test(text)) return 'default'
  const a = new RegExp(`^${key}=(.*)$`, 'm').exec(text)
  if (!a) return 'default'
  const v = a[1].trim().replace(/^"(.*)"$/, '$1')
  if (isNintendoButtonA(v)) return 'nintendo'
  // Eden réécrit lui-même, à la première sauvegarde de sa config, la touche par défaut de chaque joueur avec « default=false » : ce n'est pas un réglage de l'utilisateur.
  if (/^engine:keyboard,code:67,toggle:0$/.test(v)) return 'default'
  if (v.includes(XINPUT_GUID) || /^engine:sdl,port:\d,guid:[0-9a-f]{28}7801,button:1$/.test(v)) return 'xinput'
  return 'user'
}

/** Vrai si les touches du joueur 1 sont celles d'Eden (défaut) ou celles écrites par Kartouche : on peut alors les changer (voir `edenPlayerState`). */
export function isUntouchedEdenControls(text: string): boolean {
  return edenPlayerState(text, 0) !== 'user'
}

const resetKeys = (keys: readonly string[]): Record<string, boolean> => Object.fromEntries(keys.map((k) => [`${k}\\default`, true]))

/** Manette XInput branchée : VID/PID/version de son interface HID (XInputGetCapabilitiesEx), tels que SDL les met dans son GUID ; 0 si illisibles. `port` : rang parmi les manettes de même GUID. */
export interface EdenPad { vid: number; pid: number; ver: number; port?: number }

/** Manette Nintendo à lire (Switch Pro, paire de Joy-Con, Joy-Con gauche ou droit seul) : voir `edenPads.ts`. `port` : rang parmi les manettes identiques. */
export interface EdenNintendoPad { nintendo: EdenNintendo; port?: number }

/** Nombre de joueurs qu'Eden sait recevoir (joueurs 1 à 8). */
export const EDEN_MAX_PLAYERS = 8

/**
 * Manettes des joueurs, à chaque lancement : `pads[0]` = joueur 1, `pads[1]` = joueur 2… Chacune est une manette XInput (liaisons SDL à son GUID, voir `sdlXInputGuid`) ou
 * une manette Nintendo (profil d'`edenPads.ts`, avec le type de manette qui va avec) ; un joueur sans manette reste au clavier d'Eden (joueur 1) ou absent (les autres).
 * Un bouton d'Eden n'accepte qu'une seule liaison, d'où ce choix au lancement (comme pour Dolphin). Les liaisons de mouvement du profil XInput ne sont jamais écrites : Eden
 * garde les siennes. Eden est lancé avec le pilote XInput de SDL imposé (voir `emulatorEnv` dans sdlEnv.ts), sans quoi le GUID changerait avec le pilote retenu.
 * Un joueur configuré à la main dans Eden (autre GUID, ou bouton A déplacé) n'est plus jamais réécrit ; les autres joueurs ne sont pas affectés.
 */
export async function applyEdenPads(dir: string, pads: readonly (EdenPad | EdenNintendoPad)[]): Promise<void> {
  const file = edenConfig(dir)
  const text = await readText(file)
  const patch: Record<string, string | number | boolean> = {}
  for (let i = 0; i < EDEN_MAX_PLAYERS; i++) {
    const state = edenPlayerState(text, i)
    if (state === 'user') continue
    const pad = pads[i] ?? null
    const nintendoKeys = edenNintendoKeys(i)
    const connected = (on: boolean): Record<string, string | number | boolean> => (i === 0 ? {} : on ? qt({ [`player_${i}_connected`]: true }) : { [`player_${i}_connected\\default`]: true })
    if (pad && 'nintendo' in pad) {
      const p = edenNintendoProfile(pad.nintendo, i, pad.port ?? 0)
      Object.assign(patch, resetKeys(nintendoKeys), qt(quoteLists({ ...p.keys, [`player_${i}_type`]: p.type })), connected(true))
    } else if (pad) {
      if (!pad.vid && !pad.pid) continue // identifiants illisibles : on ne devine pas un GUID
      // Après un profil Nintendo : mouvement, Home, Capture, SL/SR et type de manette reviennent à leurs valeurs par défaut (le profil XInput ne les écrit pas).
      const back = state === 'nintendo' ? { ...resetKeys(nintendoKeys), [`player_${i}_type\\default`]: true } : {}
      Object.assign(patch, back, qt(edenXInputKeys(sdlXInputGuid(pad.vid, pad.pid, pad.ver), i, pad.port ?? 0)), connected(true))
    } else if (state === 'nintendo' || state === 'xinput') {
      const xinputKeys = Object.keys(edenControllerProfile('')).map((k) => edenPlayerKey(k, i))
      Object.assign(patch, resetKeys([...xinputKeys, ...nintendoKeys]), state === 'nintendo' ? { [`player_${i}_type\\default`]: true } : {}, connected(false))
    }
  }
  const applet = await edenAppletRestore(dir)
  if (Object.keys(patch).length === 0 && !applet) return // rien d'écrit (joueurs configurés à la main)
  await writeIni(file, { ...(Object.keys(patch).length > 0 ? { Controls: patch } : {}), ...(applet ? { UI: applet } : {}) }, '=')
}

/**
 * Applet Contrôleur d'Eden : quand un jeu demande de vérifier ou d'assigner les manettes (Mario Kart à deux joueurs…), Eden ouvre une fenêtre à valider. On NE la désactive PAS :
 * quand elle est désactivée, Eden « déduit la meilleure configuration » lui-même (journal : « ReconfigureControllers: called, deducing the best configuration ») et refait
 * toutes les manettes en Pro Controller ou paire de Joy-Con, sans tenir compte du Joy-Con seul qu'on lui a assigné. Kartouche valide la vraie applet à la place de l'utilisateur
 * (voir `edenAppletConfirm` et `autoConfirmDialogs`). Ici, on rétablit seulement l'option qu'une ancienne version de Kartouche avait désactivée (repérée par son marqueur).
 */
async function edenAppletRestore(dir: string): Promise<Record<string, string | number | boolean> | null> {
  const marker = join(dir, 'user', 'config', 'kartouche-applet-off')
  if (!existsSync(marker)) return null
  await rm(marker, { force: true })
  return { 'disableControllerApplet\\default': true }
}

/** Joueur 1 seul (voir `applyEdenPads`). */
export const applyEdenPad = (dir: string, pad: EdenPad | EdenNintendoPad | null): Promise<void> => applyEdenPads(dir, pad ? [pad] : [])

/** Profils de contrôleur réutilisables d'Eden (`config/input/<nom>.ini`, clés sans préfixe de joueur) : chargeables dans ses réglages de manette. Créés une fois. */
async function writeEdenProfiles(dir: string): Promise<void> {
  const profiles: [string, Record<string, string | number | boolean>][] = [['RomVault Clavier', qt(EDEN_KEYBOARD_PROFILE)]]
  for (const [name, keys] of profiles) {
    const file = join(dir, 'user', 'config', 'input', `${name}.ini`)
    if (!existsSync(file)) await writeIni(file, { Controls: keys }, '=')
  }
}

/** Configuration propre au jeu (Title ID) si l'exception est connue (voir `EDEN_GAME_OVERRIDES`) ; jamais d'un fichier déjà présent. */
export async function applyEdenGameConfig(dir: string, titleId: string | null | undefined, table: Record<string, IniPatch> = EDEN_GAME_OVERRIDES): Promise<void> {
  const patch = titleId ? table[titleId.toUpperCase()] : undefined
  if (!patch) return
  const file = join(dir, 'user', 'config', 'custom', `${titleId!.toUpperCase()}.ini`)
  if (!existsSync(file)) await writeIni(file, patch, '=')
}

/** melonDS ne lit qu'un joystick SDL, désigné par son rang (`JoystickID`) : celui de la manette à lire, réécrit à chaque lancement. */
export async function applyMelondsPad(dir: string, joystickId: number | null): Promise<void> {
  if (joystickId === null) return
  const file = join(dir, 'melonDS.toml')
  const text = await readText(file)
  if (!text) return
  const next = setTomlKeys(text, 'Instance0', { JoystickID: joystickId })
  if (next !== text) await writeFile(file, next)
}

/**
 * Disposition d'écrans propre au jeu (code de jeu de la ROM), appliquée avant son lancement puis restaurée au lancement d'un autre jeu :
 * melonDS n'a qu'une configuration globale. L'état (disposition d'origine, valeurs appliquées) est gardé à côté de melonDS.toml ; une valeur
 * que l'utilisateur a changée entre-temps n'est jamais restaurée. Sans exception connue pour le jeu et sans état, rien n'est touché.
 */
export async function applyMelondsGame(dir: string, gameCode: string | null, table: Record<string, ScreenOverride> = MELONDS_GAME_SCREENS): Promise<void> {
  const stateFile = join(dir, 'romvault-melonds-layout.json')
  const override = gameCode ? table[gameCode] : undefined
  const state = existsSync(stateFile) ? (JSON.parse(await readFile(stateFile, 'utf8').catch(() => 'null')) as LayoutState | null) : null
  if (!override && !state) return
  const file = join(dir, 'melonDS.toml')
  const text = await readText(file)
  if (!text) return
  const plan = planMelondsGame(tomlSection(text, 'Instance0.Window0'), state, override)
  if (Object.keys(plan.write).length) await writeFile(file, setTomlKeys(text, 'Instance0.Window0', plan.write as Record<string, string | number | boolean>))
  if (plan.state) await writeFile(stateFile, JSON.stringify(plan.state))
  else await rm(stateFile, { force: true })
}

async function configureDolphin(dir: string, ctx: ConfigContext): Promise<void> {
  const fr = ctx.lang === 'fr'
  // Vulkan ou OpenGL selon le GPU, résolution interne selon l'écran et le GPU (voir dolphin.ts).
  const graphics = dolphinGraphics(ctx.gpu ?? DEFAULT_GPU, ctx.displayHeight)
  const cfg = join(dir, 'User', 'Config')
  await writeIni(join(cfg, 'Dolphin.ini'), {
    Analytics: { PermissionAsked: true, Enabled: false },
    Interface: { LanguageCode: fr ? 'fr' : 'en', ConfirmStop: false },
    Core: {
      // Langue de la GameCube : 0 anglais, 1 allemand, 2 français, 3 espagnol, 4 italien, 5 néerlandais.
      SelectedLanguage: fr ? 2 : 0,
      // Simule une vitesse de lecture de disque irréaliste : réduit nettement le temps de lancement et les temps de
      // chargement (plus sensible sur Wii, dont les disques transportent plus de données que la GameCube). Quelques
      // jeux dépendent du vrai timing du lecteur pour démarrer (voir DOLPHIN_FAST_DISC_EXCLUSIONS, désactivé au cas
      // par cas via un fichier GameSettings) — connu de la communauté Dolphin, pas une hypothèse Kartouche.
      FastDiscSpeed: true,
      GFXBackend: graphics.backend
    },
    // Cubeb (WASAPI partagé, défaut de Dolphin sous Windows) suit le périphérique par défaut de Windows ; volume plein, Windows règle le final ; latence par défaut.
    DSP: { Backend: 'Cubeb', Volume: 100, Muted: false },
    Display: { Fullscreen: true }
  })
  await writeIni(join(cfg, 'GFX.ini'), graphics.gfx)
  // Dolphin crée lui-même ses fichiers de manettes et le SYSCONF de la Wii au premier démarrage : on le laisse faire, puis on les modifie
  // (un GCPadNew.ini partiel, écrit avant, était remplacé par des liaisons inutilisables). La langue de la Wii vit dans le SYSCONF, binaire.
  const sysconf = await dolphinCreateSysconf(dir)
  if (sysconf) {
    const data = await readFile(sysconf)
    if (setSysconfLanguage(data, fr ? 3 : 1)) await writeFile(sysconf, data)
  }
  // Clavier seul à l'installation ; la manette est ajoutée à chaque lancement selon ce qui est branché (applyDolphinPad).
  await applyDolphinPad(dir, null)
}

/**
 * Identifiants disque (6 caractères, voir `readDiscId` dans `saves.ts`) des jeux confirmés incompatibles avec
 * `FastDiscSpeed` (voir `configureDolphin`) — vide pour l'instant : la base officielle des réglages par jeu de Dolphin
 * lui-même (Data/Sys/GameSettings, vérifiée sur GitHub) ne liste aujourd'hui aucun jeu qui en a besoin désactivé (elle
 * force au contraire FastDiscSpeed=True pour Bully: Scholarship Edition, RB7E54/RB7P54 — déjà géré par Dolphin, aucune
 * action nécessaire ici). Un cas cité par une recherche web pour Mario Golf: Toadstool Tour (GFTE01) n'a pas résisté
 * à la vérification (absent de la base Dolphin, absent du wiki, absent des recherches ciblées) : ne pas le réutiliser.
 * Cette liste n'a donc vocation à être alimentée que par du confirmé (source primaire) ou par la détection automatique
 * (voir `retryDolphinWithoutFastDiscSpeed` dans `launcher.ts`, qui écrit directement le fichier GameSettings sans
 * passer par cette liste).
 */
const DOLPHIN_FAST_DISC_EXCLUSIONS = new Set<string>([])

/**
 * Désactive `FastDiscSpeed` pour un jeu, dans son propre fichier GameSettings (sans toucher au réglage global ni aux
 * autres jeux). `force` contourne la liste d'exclusion connue (utilisé par la détection automatique d'un plantage au
 * lancement, voir `launcher.ts`) ; sans lui, rien n'est écrit pour un jeu absent de la liste. Appelé à chaque
 * lancement (comme `applyDolphinPad`) : `readDiscId` a besoin du fichier ROM réel, pas seulement de sa console.
 */
export async function applyDolphinFastDiscExclusion(dir: string, gameId: string, force = false): Promise<void> {
  if (!force && !DOLPHIN_FAST_DISC_EXCLUSIONS.has(gameId)) return
  await writeIni(join(dir, 'User', 'GameSettings', `${gameId}.ini`), { Core: { FastDiscSpeed: false } })
}

// --- DuckStation / PCSX2 : clavier + première manette SDL (tout type de manette) ---------------------------------------------

const SDL_NAMES: Record<string, string> = {
  Up: 'SDL-0/DPadUp', Down: 'SDL-0/DPadDown', Left: 'SDL-0/DPadLeft', Right: 'SDL-0/DPadRight',
  Triangle: 'SDL-0/Y', Circle: 'SDL-0/B', Cross: 'SDL-0/A', Square: 'SDL-0/X', Select: 'SDL-0/Back', Start: 'SDL-0/Start',
  L1: 'SDL-0/LeftShoulder', R1: 'SDL-0/RightShoulder', L2: 'SDL-0/+LeftTrigger', R2: 'SDL-0/+RightTrigger', L3: 'SDL-0/LeftStick', R3: 'SDL-0/RightStick',
  LUp: 'SDL-0/-LeftY', LDown: 'SDL-0/+LeftY', LLeft: 'SDL-0/-LeftX', LRight: 'SDL-0/+LeftX',
  RUp: 'SDL-0/-RightY', RDown: 'SDL-0/+RightY', RLeft: 'SDL-0/-RightX', RRight: 'SDL-0/+RightX',
  LargeMotor: 'SDL-0/LargeMotor', SmallMotor: 'SDL-0/SmallMotor'
}
const SDL_PADS = [0, 1, 2, 3]

/**
 * Ajoute les manettes SDL 1 à 3 à chaque liaison `SDL-0/…` de `[Pad1]` (clé répétée = plusieurs liaisons), pour une installation faite avant que la manette 0 seule ne pose problème.
 * Idempotent ; le clavier, les moteurs de vibration et ce que l'utilisateur a mis sur d'autres manettes ne sont pas touchés.
 */
export function expandSdlPads(text: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const head = lines.findIndex((l) => l.trim() === '[Pad1]')
  if (head < 0) return text
  let end = lines.findIndex((l, i) => i > head && /^\s*\[/.test(l))
  if (end < 0) end = lines.length
  const section = lines.slice(head + 1, end)
  const out: string[] = []
  for (const line of section) {
    out.push(line)
    const m = /^(\s*)([A-Za-z0-9]+)(\s*=\s*)SDL-0\/(.+?)\s*$/.exec(line)
    if (!m || /Motor$/.test(m[2])) continue
    for (const i of SDL_PADS.slice(1)) {
      const added = `${m[1]}${m[2]}${m[3]}SDL-${i}/${m[4]}`
      if (!section.some((l) => l.trim() === added.trim())) out.push(added)
    }
  }
  return [...lines.slice(0, head + 1), ...out, ...lines.slice(end)].join(nl)
}

/** DuckStation (settings.ini) et PCSX2 (inis/PCSX2.ini) : la manette utilisée peut être n'importe laquelle des quatre premières. */
export async function applyPsPads(file: string): Promise<void> {
  const text = await readText(file)
  if (!text) return
  const next = expandSdlPads(text)
  if (next !== text) await writeFile(file, next)
}

/** Liaisons de la manette PlayStation : le clavier d'origine de l'émulateur puis la manette (clé répétée = plusieurs liaisons). */
const psPad = (arrows: [string, string, string, string], enter: string): Record<string, string | readonly string[]> => {
  const kb: Record<string, string> = {
    Up: arrows[0], Right: arrows[1], Down: arrows[2], Left: arrows[3],
    Triangle: 'Keyboard/I', Circle: 'Keyboard/L', Cross: 'Keyboard/K', Square: 'Keyboard/J', Select: 'Keyboard/Backspace', Start: enter,
    L1: 'Keyboard/Q', L2: 'Keyboard/1', R1: 'Keyboard/E', R2: 'Keyboard/3', L3: 'Keyboard/2', R3: 'Keyboard/4',
    LUp: 'Keyboard/W', LRight: 'Keyboard/D', LDown: 'Keyboard/S', LLeft: 'Keyboard/A', RUp: 'Keyboard/T', RRight: 'Keyboard/H', RDown: 'Keyboard/G', RLeft: 'Keyboard/F'
  }
  const out: Record<string, string | readonly string[]> = {}
  // Clavier, puis les manettes SDL 0 à 3 : Sunshine ajoute des manettes virtuelles, la manette utilisée n'est pas forcément la première (voir padChoice.ts).
  for (const [k, key] of Object.entries(kb)) out[k] = [key, ...SDL_PADS.map((i) => SDL_NAMES[k].replace('SDL-0', `SDL-${i}`))]
  out.LargeMotor = SDL_NAMES.LargeMotor
  out.SmallMotor = SDL_NAMES.SmallMotor
  return out
}

/**
 * Rend un émulateur directement utilisable : langue de l'app, plein écran, résolution interne ≥ 1080p (adaptée à l'écran), BIOS, manette.
 * Appelé une seule fois, à l'installation : une mise à jour ne réécrit jamais les réglages de l'utilisateur.
 */
export async function configureEmulator(id: string, dir: string, ctx: ConfigContext): Promise<void> {
  await mkdir(dir, { recursive: true })
  const fr = ctx.lang === 'fr'
  const tier = resolutionTier(ctx.displayHeight)
  const gpu = ctx.gpu ?? DEFAULT_GPU
  switch (id) {
    case 'retroarch': {
      const cfg = join(dir, 'retroarch.cfg')
      // Les manettes sont reconnues seules (autoconfig) ; Échap quitte d'un seul appui, sans confirmation.
      await writeFile(cfg, patchCfg(await readText(cfg), {
        system_directory: ctx.biosDir, video_fullscreen: true, video_windowed_fullscreen: true, user_language: fr ? 2 : 0,
        quit_press_twice: false, input_autodetect_enable: true, input_quit_gamepad_combo: 3, ...retroarchVideo(gpu), ...retroarchAudio
      }))
      // Réglages propres à un cœur (override + options) dans `config/<cœur>/` : RetroArch ne lit pas de fichier d'options global.
      for (const core of Object.values(RETROARCH_CORE_CONFIG)) {
        const base = join(dir, 'config', core.name, core.name)
        await mkdir(dirname(base), { recursive: true })
        if (core.override) await writeFile(`${base}.cfg`, patchCfg(await readText(`${base}.cfg`), core.override(gpu)))
        if (core.options) await writeFile(`${base}.opt`, patchCfg(await readText(`${base}.opt`), core.options(gpu, tier)))
      }
      return
    }
    case 'duckstation':
      return writeIni(join(dir, 'settings.ini'), {
        // Les traductions sont fournies avec l'exe (translations/duckstation-qt_fr.qm, etc.) : « Language » est sans risque, contrairement à une ancienne hypothèse.
        Main: { StartFullscreen: true, ConfirmPowerOff: false, SetupWizardIncomplete: false, Language: fr ? 'fr' : 'en' },
        // Rendu (Vulkan / D3D11 en repli, GPU choisi, résolution, PGXP) et audio : voir duckstation.ts.
        GPU: duckstationGpu(gpu, ctx.displayHeight),
        BIOS: { SearchDirectory: ctx.biosDir },
        InputSources: { SDL: true },
        Pad1: { Type: 'AnalogController', ...psPad(['Keyboard/UpArrow', 'Keyboard/RightArrow', 'Keyboard/DownArrow', 'Keyboard/LeftArrow'], 'Keyboard/Enter') }
      })
    case 'dolphin':
      return configureDolphin(dir, ctx)
    case 'pcsx2': {
      const keys = ['Keyboard/Up', 'Keyboard/Right', 'Keyboard/Down', 'Keyboard/Left'] as [string, string, string, string]
      await writeIni(join(dir, 'inis', 'PCSX2.ini'), {
        // SettingsVersion : sans lui PCSX2 juge le fichier invalide et propose de tout réinitialiser.
        UI: { SettingsVersion: 1, SetupWizardIncomplete: false, StartFullscreen: true, Language: fr ? 'fr-FR' : 'en-US', ConfirmShutdown: false },
        // Rendu (Vulkan / D3D11 en repli, GPU choisi, résolution) : voir pcsx2.ts. Audio : rien à écrire, les défauts de PCSX2 (Cubeb, périphérique Windows,
        // volume 100) sont déjà ceux voulus et un réglage personnel reste intact.
        'EmuCore/GS': pcsx2Gs(gpu, ctx.displayHeight),
        Folders: { Bios: ctx.biosDir },
        InputSources: { SDL: true },
        Pad1: { Type: 'DualShock2', ...psPad(keys, 'Keyboard/Return') }
      })
      // Profils de manette réutilisables (inputprofiles/) : manette SDL seule, clavier seul. Créés une fois, jamais modifiés.
      const pad = psPad(keys, 'Keyboard/Return')
      for (const [name, pick_] of [[PCSX2_PROFILE_NAMES.pad, (v: string) => v.startsWith('SDL')], [PCSX2_PROFILE_NAMES.keyboard, (v: string) => v.startsWith('Keyboard')]] as const) {
        const file = join(dir, 'inputprofiles', `${name}.ini`)
        if (existsSync(file)) continue
        const entries = Object.fromEntries(Object.entries(pad).map(([k, v]) => [k, (Array.isArray(v) ? (v as string[]) : [v as string]).filter(pick_)]).filter(([, v]) => v.length))
        await writeIni(file, { Pad1: { Type: 'DualShock2', ...entries } })
      }
      return
    }
    case 'melonds': {
      // Fusion (pas createOnce) : un melonDS.toml partiel peut déjà exister (lancement manuel de l'utilisateur avant
      // installation via Kartouche), sinon rendu/langue/manette ne seraient jamais écrits. Réglages et choix : voir melonds.ts.
      const file = join(dir, 'melonDS.toml')
      let text = await readText(file)
      const render = melondsRendering(gpu, ctx.displayHeight)
      text = setTomlKeys(text, '3D', { Renderer: render.renderer })
      text = setTomlKeys(text, '3D.GL', { ScaleFactor: render.scale })
      // Rendu logiciel (GPU ancien) : threadé ; sans effet quand le rendu est OpenGL.
      text = setTomlKeys(text, '3D.Soft', { Threaded: true })
      text = setTomlKeys(text, 'Screen', { UseGL: render.renderer !== 0 })
      // [Instance0] doit exister EN TANT QUE SECTION EXPLICITE avant ses sous-tables (Firmware, Keyboard) : sinon TOML ne
      // crée qu'une table « implicite » pour Instance0, que melonDS refuse de réécrire au premier lancement
      // (`toml::serializer: an implicit table cannot have non-table value`, plantage immédiat ; fonctionne ensuite, une
      // fois que melonDS a lui-même réécrit un fichier complet avec un [Instance0] explicite).
      text = setTomlKeys(text, 'Instance0', {})
      text = setTomlKeys(text, 'Instance0.Firmware', { OverrideSettings: true, Language: fr ? 2 : 1 })
      text = setTomlKeys(text, 'Instance0.Window0', MELONDS_WINDOW)
      // Audio : pilote SDL de melonDS sur le périphérique par défaut de Windows ; 256 = 100 % (Windows règle le volume final).
      text = setTomlKeys(text, 'Instance0.Audio', { Volume: 256 })
      text = setTomlKeys(text, 'Instance0.Keyboard', MELONDS_KEYBOARD)
      text = setTomlKeys(text, 'Instance0.Joystick', MELONDS_JOYSTICK)
      await mkdir(dirname(file), { recursive: true })
      return writeFile(file, text)
    }
    case 'azahar': {
      // La langue de la console (pas celle de l'appli, ci-dessous) vit dans le NAND émulé : voir `azaharCfgPath`.
      // confirmClose : sans ça, une fermeture demandée par Kartouche (bouton, manette) ouvre la boîte de confirmation
      // d'Azahar au lieu de fermer — comme ConfirmStop/ConfirmPowerOff/ConfirmShutdown pour Dolphin/DuckStation/PCSX2.
      // Rendu, disposition et audio : voir azahar.ts. Contrôles : profil 1 (index 0) = clavier d'Azahar, profil 2 = manette ; lequel est actif
      // dépend de ce qui est branché, choisi au lancement (voir `applyAzaharPad`). La souris (tactile) et le mouvement sont dans les deux profils.
      const file = join(dir, 'user', 'config', 'qt-config.ini')
      await writeIni(file, {
        Renderer: qt(azaharRenderer(gpu, ctx.displayHeight)),
        Layout: qt(AZAHAR_LAYOUT),
        Audio: qt(AZAHAR_AUDIO),
        UI: qt({ fullscreen: true, language: fr ? 'fr' : 'en', confirmClose: false, ...AZAHAR_CONTROLLER_HOTKEYS }),
        Controls: { ...qt({ profile: 0, ...quoteLists(AZAHAR_CONTROLLER_PROFILE) }), ...AZAHAR_TOUCH_BUTTONS, 'profiles\\size': 2, 'profiles\\1\\name': 'Clavier' }
      }, '=')
      // Le fichier de langue de la console est créé dès le premier démarrage (vérifié sur Azahar 2126) : on le laisse le faire, puis on le patche,
      // pour que même le tout premier jeu soit dans la bonne langue.
      const cfg = azaharCfgPath(dir)
      await runOnceUntil(join(dir, 'azahar.exe'), dir, () => existsSync(cfg))
      if (existsSync(cfg)) {
        const data = await readFile(cfg)
        if (setCfgLanguage(data, fr ? 2 : 1)) await writeFile(cfg, data)
      }
      return
    }
    case 'cemu': {
      // Réglages, profils de manette et (à l'installation, voir installer.ts) graphic packs : voir cemu.ts.
      await createOnce(join(dir, 'settings.xml'), cemuSettingsXml(fr, ctx.gpu ?? DEFAULT_GPU))
      await createOnce(join(dir, 'controllerProfiles', 'controller0.xml'), cemuProfileXml('pro'))
      return writeCemuProfiles(dir)
    }
    case 'eden':
      // confirmStop=2 (ConfirmStop::Ask_Never) : sans ça, un « Fermer le jeu » de Kartouche (ou le raccourci manette
      // Retour+Start) ouvre la boîte de confirmation d'Eden au lieu de fermer — comme confirmClose pour Azahar.
      // Valeur et section (« UI », catégorie UiGeneral) vérifiées contre le code source réel d'Eden
      // (src/qt_common/config/uisettings.h, src/common/settings_enums.h, src/common/settings.cpp TranslateCategory).
      // Graphismes : Vulkan (périphérique 0 = celui que l'ordre de Vulkan met en tête, le GPU performant), caches de shaders et de pipelines
      // explicites (ce sont déjà les défauts). Audio : moteur et périphérique « auto » (suit le périphérique par défaut de Windows), volume
      // 100 %, aucune latence forcée. Contrôles : clavier d'Eden à l'installation, la manette est ajoutée au lancement (voir `applyEdenPad`).
      return writeIni(join(dir, 'user', 'config', 'qt-config.ini'), {
        Renderer: qt({ backend: edenBackend(gpu), resolution_setup: edenResolution(gpu, ctx.displayHeight, ctx.edenNewResolutions ?? true), use_disk_shader_cache: true, use_vulkan_driver_pipeline_cache: true }),
        System: qt({ language_index: fr ? 2 : 1 }),
        UI: qt({ fullscreen: true, language: fr ? 'fr' : 'en', confirmStop: 2 }),
        Audio: qt({ output_engine: 0, output_device: 'auto', volume: 100, audio_muted: false })
      }, '=').then(() => writeEdenProfiles(dir))
    case 'ppsspp':
      return writeIni(join(dir, 'memstick', 'PSP', 'SYSTEM', 'ppsspp.ini'), {
        // AskForExitConfirmationAfterSeconds = 0 : sans ça, PPSSPP demande confirmation à la fermeture (bouton,
        // Retour+Start) dès que la partie dure depuis plus de 5 min (défaut 300) — comme confirmClose pour Azahar.
        General: { Language: fr ? 'fr_FR' : 'en_US', AskForExitConfirmationAfterSeconds: 0 },
        SystemParam: { Language: fr ? 2 : 1 },
        // Vulkan (D3D11 en repli), GPU détecté, résolution entière adaptée à l'écran : voir ppsspp.ts.
        Graphics: ppssppGraphics(gpu, ctx.displayHeight)
      })
    case 'rpcs3':
      // Rendu (Vulkan / OpenGL en repli, GPU, résolution) et langue : voir rpcs3.ts. Audio : rien à écrire (défauts de RPCS3 : Cubeb, périphérique Windows, volume 100).
      await createOnce(join(dir, 'config', 'config.yml'), rpcs3ConfigYaml(gpu, ctx.displayHeight, fr))
      // confirmationBoxBootGame/confirmationBoxExitGame à false : sans ça, RPCS3 affiche une boîte « Boot this game? »
      // à chaque lancement et « Exit RPCS3? » à la fermeture (bouton, Retour+Start) au lieu de fermer — comme
      // confirmClose pour Azahar / confirmStop pour Eden. infoBoxEnabledWelcome à false : fenêtre « Welcome to RPCS3 ».
      // Le fichier est `GuiConfigs/CurrentSettings.ini` à la racine de RPCS3 (vérifié : RPCS3 n'a jamais lu `config/GuiConfigs`).
      return writeIni(join(dir, 'GuiConfigs', 'CurrentSettings.ini'), {
        main_window: { startGameFullscreen: true, confirmationBoxBootGame: false, confirmationBoxExitGame: false, infoBoxEnabledWelcome: false }
      }, '=')
    case 'vita3k': {
      // confirmExitApp à false (réglage Qt, fichier ini indépendant de config.yml, fusion sans besoin que Vita3K
      // ait déjà tourné) : sans ça, une fermeture demandée par Kartouche (bouton, Retour+Start) ouvre « Exit App? / Do
      // you really want to exit the app? » au lieu de fermer — vérifié en vrai (la clé n'est PAS
      // `mw_confirmExitApp` : avec ce nom la boîte s'ouvrait toujours, sans préfixe elle disparaît).
      await writeIni(join(dir, 'gui-configs', 'CurrentSettings.ini'), { MainWindow: { confirmExitApp: false } }, '=')
      // Vita3K ignore un config.yml partiel : on le laisse créer le sien (premier démarrage), puis on en change les valeurs.
      const file = join(dir, 'config.yml')
      if (!existsSync(file)) await runOnceUntil(join(dir, 'Vita3K.exe'), dir, () => existsSync(file) && readFileSync(file, 'utf8').includes('sys-lang'))
      if (!existsSync(file)) return
      // show-welcome à false : sans ça, Vita3K réaffiche sa fenêtre « Welcome to Vita3K » à chaque lancement de jeu,
      // même une fois le firmware installé — comme confirmClose pour Azahar. warn-missing-firmware à false : notre
      // assistant BIOS n'installe que le firmware de base, jamais le paquet de polices (étape séparée, facultative) ;
      // sans ce réglage, Vita3K bloque l'auto-boot derrière un avertissement « firmware manquant » qui attend un clic
      // (constaté en vrai : le jeu ne démarre jamais tant que cette boîte n'est pas fermée). confirm_exit_app : clé
      // héritée d'une ancienne interface (ImGui), gardée sans certitude qu'elle serve encore avec l'interface Qt
      // actuelle — le vrai réglage Qt est confirmExitApp ci-dessus.
      // check-for-updates-mode à 0 : sans ça, une fenêtre « Update Available » (version CI plus récente) s'ouvre par-dessus le jeu à chaque lancement (vérifié : 0 la supprime).
      return writeFile(file, patchYaml(await readText(file), {
        'sys-lang': fr ? 2 : 1, ...vita3kRenderer(gpu, ctx.displayHeight), 'boot-apps-full-screen': true,
        'show-welcome': false, 'warn-missing-firmware': false, 'confirm_exit_app': false, 'check-for-updates-mode': 0
      }))
    }
  }
}
