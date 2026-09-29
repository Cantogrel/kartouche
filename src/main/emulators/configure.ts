import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Ce dont la configuration automatique a besoin : langue de l'app, taille de l'écran, dossier de BIOS de l'émulateur. */
export interface ConfigContext {
  lang: 'en' | 'fr'
  /** Hauteur de l'écran principal en pixels physiques. */
  displayHeight: number
  biosDir: string
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
 * Une expression Dolphin qui cite un périphérique absent est invalide EN ENTIER (clavier compris) : on ne cite donc que la
 * manette réellement branchée, ce qui impose d'écrire ces liaisons au lancement du jeu (voir `applyDolphinPad`).
 */
const pad = (device: string | null, control: string): string | null => (device ? `\`${device}:${control}\`` : null)
const kbOrPad = (kb: string, device: string | null, control: string): string => [kb, pad(device, control)].filter(Boolean).join(' | ')

/** Liaisons GameCube + Wiimote/Nunchuk : clavier, et manette XInput (`XInput/<n>/Gamepad`) si `device` est donné. */
export function dolphinInputs(device: string | null): { gc: IniPatch; wii: IniPatch } {
  const k = (kb: string, control: string): string => kbOrPad(kb, device, control)
  const rumble = device ? `\`${device}:Motor L\` | \`${device}:Motor R\`` : ''
  // Sans « Device », les touches non qualifiées (clavier) n'ont aucun périphérique de référence et ne répondent pas.
  const gc: Record<string, string> = {
    Device: 'DInput/0/Keyboard Mouse',
    'Buttons/A': k('`X`', 'Button A'), 'Buttons/B': k('`Z`', 'Button B'), 'Buttons/X': k('`C`', 'Button X'), 'Buttons/Y': k('`S`', 'Button Y'),
    'Buttons/Z': k('`D`', 'Shoulder R'), 'Buttons/Start': k('`RETURN`', 'Start'),
    'Main Stick/Up': k('`UP`', 'Left Y+'), 'Main Stick/Down': k('`DOWN`', 'Left Y-'), 'Main Stick/Left': k('`LEFT`', 'Left X-'), 'Main Stick/Right': k('`RIGHT`', 'Left X+'),
    'C-Stick/Up': k('`I`', 'Right Y+'), 'C-Stick/Down': k('`K`', 'Right Y-'), 'C-Stick/Left': k('`J`', 'Right X-'), 'C-Stick/Right': k('`L`', 'Right X+'),
    'Triggers/L': k('`Q`', 'Trigger L'), 'Triggers/R': k('`W`', 'Trigger R'),
    'D-Pad/Up': k('`T`', 'Pad N'), 'D-Pad/Down': k('`G`', 'Pad S'), 'D-Pad/Left': k('`F`', 'Pad W'), 'D-Pad/Right': k('`H`', 'Pad E')
  }
  // Toujours écrits (vides sans manette) pour effacer la manette citée lors d'un lancement précédent.
  gc['Triggers/L-Analog'] = pad(device, 'Trigger L') ?? ''
  gc['Triggers/R-Analog'] = pad(device, 'Trigger R') ?? ''
  gc['Rumble/Motor'] = rumble
  // Wiimote + Nunchuk : sticks, boutons et pointeur (stick droit) ; le clavier et la souris restent actifs.
  const wii: Record<string, string> = {
    Source: '1',
    Device: 'DInput/0/Keyboard Mouse',
    Extension: 'Nunchuk',
    'Buttons/A': k('`Click 0`', 'Button A'), 'Buttons/B': k('`Click 1`', 'Trigger R'), 'Buttons/1': k('`1`', 'Button X'), 'Buttons/2': k('`2`', 'Button Y'),
    'Buttons/-': k('Q', 'Back'), 'Buttons/+': k('E', 'Start'), 'Buttons/Home': k('RETURN', 'Thumb R'),
    'D-Pad/Up': k('UP', 'Pad N'), 'D-Pad/Down': k('DOWN', 'Pad S'), 'D-Pad/Left': k('LEFT', 'Pad W'), 'D-Pad/Right': k('RIGHT', 'Pad E'),
    'IR/Up': k('`Cursor Y-`', 'Right Y+'), 'IR/Down': k('`Cursor Y+`', 'Right Y-'), 'IR/Left': k('`Cursor X-`', 'Right X-'), 'IR/Right': k('`Cursor X+`', 'Right X+'),
    'Shake/X': k('`Click 2`', 'Shoulder R'), 'Shake/Y': k('`Click 2`', 'Shoulder R'), 'Shake/Z': k('`Click 2`', 'Shoulder R'),
    'Nunchuk/Buttons/C': k('`Shift`', 'Shoulder L'), 'Nunchuk/Buttons/Z': k('`Ctrl`', 'Trigger L'),
    'Nunchuk/Stick/Up': k('W', 'Left Y+'), 'Nunchuk/Stick/Down': k('S', 'Left Y-'), 'Nunchuk/Stick/Left': k('A', 'Left X-'), 'Nunchuk/Stick/Right': k('D', 'Left X+')
  }
  wii['Rumble/Motor'] = rumble
  return { gc: { GCPad1: gc }, wii: { Wiimote1: wii } }
}

/**
 * Vrai si le fichier de manette GameCube est absent, celui de RomVault (bouton A = touche X, éventuellement suivie de la manette) ou un
 * état inutilisable (« Button A » sans périphérique alors que le périphérique par défaut est le clavier) : on peut alors le réécrire.
 */
export function isUntouchedPadFile(text: string): boolean {
  const a = /^\s*Buttons\/A\s*=\s*(.*?)\s*$/m.exec(text)
  if (!a) return true
  if (/^`X`(\s*\|.*)?$/.test(a[1])) return true
  return a[1] === '`Button A`' && /^\s*Device\s*=\s*DInput\/\d+\/Keyboard Mouse\s*$/m.test(text)
}

/**
 * Écrit les liaisons clavier + manette de Dolphin. Appelé au lancement d'un jeu avec la manette XInput branchée (ou null) : les
 * réglages faits à la main par l'utilisateur ne sont pas touchés (on ne réécrit que si « Bouton A » est encore celui que RomVault a écrit).
 */
export async function applyDolphinPad(dir: string, xinputSlot: number | null): Promise<void> {
  const cfg = join(dir, 'User', 'Config')
  const gcFile = join(cfg, 'GCPadNew.ini')
  if (!isUntouchedPadFile(await readText(gcFile))) return
  const { gc, wii } = dolphinInputs(xinputSlot === null ? null : `XInput/${xinputSlot}/Gamepad`)
  await writeIni(gcFile, gc)
  await writeIni(join(cfg, 'WiimoteNew.ini'), wii)
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
const sdlButton = (button: number): string => `button:${button},engine:sdl,guid:${XINPUT_GUID},maptype:all,port:0`
const sdlTrigger = (axis: number): string => `axis:${axis},direction:+,threshold:0.5,engine:sdl,guid:${XINPUT_GUID},maptype:all,port:0`
const sdlAnalog = (axisX: number, axisY: number): string => `axis_x:${axisX},axis_y:${axisY},deadzone:0.100000,engine:sdl,guid:${XINPUT_GUID},maptype:all,port:0`

/**
 * Second profil de manette d'Azahar (profil 1 = celui créé par Azahar lui-même au clavier, jamais touché) : boutons
 * croisés sur la position physique d'une manette Xbox (3DS A ↔ Xbox B, à droite ; 3DS Y ↔ Xbox X, à gauche), ZL/ZR sur
 * les gâchettes analogiques, sticks en direct (pas émulés depuis des boutons). Activé par défaut (`profile=1`) ; le
 * profil clavier d'origine reste disponible dans le sélecteur de profil d'Azahar.
 */
const AZAHAR_CONTROLLER_PROFILE: Record<string, string | number> = {
  'profiles\\2\\name': 'Manette',
  'profiles\\2\\input_maptype': 1,
  'profiles\\2\\button_a': sdlButton(SDL_BUTTON.B), 'profiles\\2\\button_b': sdlButton(SDL_BUTTON.A),
  'profiles\\2\\button_x': sdlButton(SDL_BUTTON.Y), 'profiles\\2\\button_y': sdlButton(SDL_BUTTON.X),
  'profiles\\2\\button_up': sdlButton(SDL_BUTTON.Up), 'profiles\\2\\button_down': sdlButton(SDL_BUTTON.Down),
  'profiles\\2\\button_left': sdlButton(SDL_BUTTON.Left), 'profiles\\2\\button_right': sdlButton(SDL_BUTTON.Right),
  'profiles\\2\\button_l': sdlButton(SDL_BUTTON.L), 'profiles\\2\\button_r': sdlButton(SDL_BUTTON.R),
  'profiles\\2\\button_start': sdlButton(SDL_BUTTON.Start), 'profiles\\2\\button_select': sdlButton(SDL_BUTTON.Back),
  'profiles\\2\\button_zl': sdlTrigger(SDL_AXIS.TriggerLeft), 'profiles\\2\\button_zr': sdlTrigger(SDL_AXIS.TriggerRight),
  'profiles\\2\\button_home': sdlButton(SDL_BUTTON.LeftStick),
  'profiles\\2\\circle_pad': sdlAnalog(SDL_AXIS.LeftX, SDL_AXIS.LeftY),
  'profiles\\2\\c_stick': sdlAnalog(SDL_AXIS.RightX, SDL_AXIS.RightY),
  'profiles\\2\\motion_device': 'engine:motion_emu,update_period:100,sensitivity:0.01,tilt_clamp:90.0',
  'profiles\\2\\touch_device': 'engine:emu_window',
  'profiles\\2\\udp_input_address': '127.0.0.1', 'profiles\\2\\udp_input_port': 26760, 'profiles\\2\\udp_pad_index': 0
}

// --- Eden : manette SDL (même GUID XInput générique qu'Azahar, mais format de Param différent — pas de `maptype`,
// `invert` au lieu de `direction`, pas de deadzone par liaison — vérifié contre le code source réel d'Eden :
// BuildButtonParamPackageForButton / BuildParamPackageForAnalog, src/input_common/drivers/sdl_driver.cpp). ------------
const edenButton = (button: number): string => `engine:sdl,port:0,guid:${XINPUT_GUID},button:${button}`
const edenTrigger = (axis: number): string => `engine:sdl,port:0,guid:${XINPUT_GUID},axis:${axis},threshold:0.5,invert:+`
const edenStick = (axisX: number, axisY: number): string =>
  `engine:sdl,port:0,guid:${XINPUT_GUID},axis_x:${axisX},axis_y:${axisY},offset_x:0,offset_y:0,invert_x:+,invert_y:+`

/**
 * Manette du joueur 1 (1re manette XInput détectée : `port` désambiguïse plusieurs manettes au même GUID générique,
 * ce n'est pas un index XInput). ABXY et croix sur leurs positions physiques, ZL/ZR sur les gâchettes analogiques
 * (comme le fait Eden lui-même pour une manette détectée : NativeButton::ZL/ZR n'ont pas d'équivalent bouton SDL),
 * +/- sur Start/Back. Pas de liaison pour SL/SR (rails Joy-Con détachée, aucun équivalent sur une manette Xbox) ni
 * Home/Capture (le bouton Guide n'est pas remonté par l'API XInput). Chaque clé nécessite sa liaison `\default=false`
 * (`qt()`) : `ReadStringSetting` ignore silencieusement la valeur écrite si ce marqueur est absent ou à `true`
 * (src/frontend_common/config.cpp). Joueur 1 connecté en Pro Controller par défaut, sans réglage à écrire (Config::ReadPlayerValues).
 * Jamais testé avec une vraie manette (aucune sur cette machine de développement).
 */
const EDEN_CONTROLLER_PROFILE: Record<string, string> = {
  player_0_button_a: edenButton(SDL_BUTTON.A), player_0_button_b: edenButton(SDL_BUTTON.B),
  player_0_button_x: edenButton(SDL_BUTTON.X), player_0_button_y: edenButton(SDL_BUTTON.Y),
  player_0_button_l: edenButton(SDL_BUTTON.L), player_0_button_r: edenButton(SDL_BUTTON.R),
  player_0_button_zl: edenTrigger(SDL_AXIS.TriggerLeft), player_0_button_zr: edenTrigger(SDL_AXIS.TriggerRight),
  player_0_button_plus: edenButton(SDL_BUTTON.Start), player_0_button_minus: edenButton(SDL_BUTTON.Back),
  player_0_button_lstick: edenButton(SDL_BUTTON.LeftStick), player_0_button_rstick: edenButton(SDL_BUTTON.RightStick),
  player_0_button_dup: edenButton(SDL_BUTTON.Up), player_0_button_ddown: edenButton(SDL_BUTTON.Down),
  player_0_button_dleft: edenButton(SDL_BUTTON.Left), player_0_button_dright: edenButton(SDL_BUTTON.Right),
  player_0_lstick: edenStick(SDL_AXIS.LeftX, SDL_AXIS.LeftY), player_0_rstick: edenStick(SDL_AXIS.RightX, SDL_AXIS.RightY)
}

async function configureDolphin(dir: string, ctx: ConfigContext, tier: 1 | 2 | 3): Promise<void> {
  const fr = ctx.lang === 'fr'
  const cfg = join(dir, 'User', 'Config')
  await writeIni(join(cfg, 'Dolphin.ini'), {
    Analytics: { PermissionAsked: true, Enabled: false },
    Interface: { LanguageCode: fr ? 'fr' : 'en', ConfirmStop: false },
    // Langue de la GameCube : 0 anglais, 1 allemand, 2 français, 3 espagnol, 4 italien, 5 néerlandais.
    Core: { SelectedLanguage: fr ? 2 : 0 },
    Display: { Fullscreen: true }
  })
  await writeIni(join(cfg, 'GFX.ini'), { Settings: { InternalResolution: pick(tier, [3, 4, 6]) } })
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

// --- DuckStation / PCSX2 : clavier + première manette SDL (tout type de manette) ---------------------------------------------

const SDL_NAMES: Record<string, string> = {
  Up: 'SDL-0/DPadUp', Down: 'SDL-0/DPadDown', Left: 'SDL-0/DPadLeft', Right: 'SDL-0/DPadRight',
  Triangle: 'SDL-0/Y', Circle: 'SDL-0/B', Cross: 'SDL-0/A', Square: 'SDL-0/X', Select: 'SDL-0/Back', Start: 'SDL-0/Start',
  L1: 'SDL-0/LeftShoulder', R1: 'SDL-0/RightShoulder', L2: 'SDL-0/+LeftTrigger', R2: 'SDL-0/+RightTrigger', L3: 'SDL-0/LeftStick', R3: 'SDL-0/RightStick',
  LUp: 'SDL-0/-LeftY', LDown: 'SDL-0/+LeftY', LLeft: 'SDL-0/-LeftX', LRight: 'SDL-0/+LeftX',
  RUp: 'SDL-0/-RightY', RDown: 'SDL-0/+RightY', RLeft: 'SDL-0/-RightX', RRight: 'SDL-0/+RightX',
  LargeMotor: 'SDL-0/LargeMotor', SmallMotor: 'SDL-0/SmallMotor'
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
  for (const [k, key] of Object.entries(kb)) out[k] = [key, SDL_NAMES[k]]
  out.LargeMotor = SDL_NAMES.LargeMotor
  out.SmallMotor = SDL_NAMES.SmallMotor
  return out
}

// --- Cemu : profil manette Wii U GamePad (clavier + 1ère manette XInput) -------------------------------------------------

/**
 * Identifiants VPAD::ButtonId de Cemu (src/input/emulated/VPADController.h) — champ `<mapping>` des entrées du profil.
 * Reste stable tant que Cemu ne change pas cet enum (jamais réordonné depuis sa création).
 */
const VPAD_BUTTON: Record<string, number> = {
  A: 1, B: 2, X: 3, Y: 4, L: 5, R: 6, ZL: 7, ZR: 8, Plus: 9, Minus: 10, Up: 11, Down: 12, Left: 13, Right: 14,
  StickL: 15, StickR: 16, StickL_Up: 17, StickL_Down: 18, StickL_Left: 19, StickL_Right: 20,
  StickR_Up: 21, StickR_Down: 22, StickR_Left: 23, StickR_Right: 24, Home: 27
}

/** Une entrée `<mapping>{vpad}</mapping><button>{physique}</button>` du profil (voir InputManager::save, Cemu). */
const cemuEntry = (vpad: keyof typeof VPAD_BUTTON, physical: number): string => `      <entry><mapping>${VPAD_BUTTON[vpad]}</mapping><button>${physical}</button></entry>`

/** Un bloc `<controller>` du profil (api/uuid/display_name fixes à la source de chaque backend de Cemu). */
const cemuController = (api: string, uuid: string, displayName: string, deadzone: number, entries: string): string => `    <controller>
      <api>${api}</api>
      <uuid>${uuid}</uuid>
      <display_name>${displayName}</display_name>
      <axis><deadzone>${deadzone}</deadzone><range>1</range></axis>
      <rotation><deadzone>${deadzone}</deadzone><range>1</range></rotation>
      <trigger><deadzone>${deadzone}</deadzone><range>1</range></trigger>
      <mappings>
${entries}
      </mappings>
    </controller>`

/**
 * Profil par défaut du Pad 1 (Wii U GamePad) : clavier (mêmes touches que le schéma PlayStation de ce fichier — IJKL pour
 * les boutons, WASD pour le stick gauche, THGF pour le droit, flèches pour la croix) + 1ère manette XInput détectée
 * (identifiants génériques Cemu, valides même sans manette branchée à l'installation — comme pour Dolphin, voir
 * `applyDolphinPad`). Écrit une seule fois : Cemu réécrit ensuite lui-même ce fichier dès que l'utilisateur retouche ses
 * réglages de manette, jamais RomVault.
 */
const CEMU_GAMEPAD_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<emulated_controller>
  <type>Wii U GamePad</type>
  <toggle_display>0</toggle_display>
${cemuController('Keyboard', 'keyboard', 'Keyboard', 0.25, [
    cemuEntry('A', 76), cemuEntry('B', 75), cemuEntry('X', 73), cemuEntry('Y', 74),
    cemuEntry('L', 81), cemuEntry('R', 69), cemuEntry('ZL', 49), cemuEntry('ZR', 51),
    cemuEntry('Plus', 13), cemuEntry('Minus', 8),
    cemuEntry('Up', 38), cemuEntry('Down', 40), cemuEntry('Left', 37), cemuEntry('Right', 39),
    cemuEntry('StickL', 50), cemuEntry('StickR', 52),
    cemuEntry('StickL_Up', 87), cemuEntry('StickL_Down', 83), cemuEntry('StickL_Left', 65), cemuEntry('StickL_Right', 68),
    cemuEntry('StickR_Up', 84), cemuEntry('StickR_Down', 71), cemuEntry('StickR_Left', 70), cemuEntry('StickR_Right', 72),
    cemuEntry('Home', 27)
  ].join('\n'))}
${cemuController('XInput', '0', 'Controller 1', 0.15, [
    // Table par défaut de Cemu pour XInput (VPADController::set_default_mapping) : kButton0..15 = boutons XInput, kAxis/kRotation/kTrigger = sticks/gâchettes.
    cemuEntry('Up', 0), cemuEntry('Down', 1), cemuEntry('Left', 2), cemuEntry('Right', 3),
    cemuEntry('Plus', 4), cemuEntry('Minus', 5), cemuEntry('StickL', 6), cemuEntry('StickR', 7),
    cemuEntry('L', 8), cemuEntry('R', 9), cemuEntry('B', 12), cemuEntry('A', 13), cemuEntry('Y', 14), cemuEntry('X', 15),
    cemuEntry('StickL_Right', 38), cemuEntry('StickL_Up', 39), cemuEntry('StickR_Right', 40), cemuEntry('StickR_Up', 41),
    cemuEntry('ZL', 42), cemuEntry('ZR', 43), cemuEntry('StickL_Left', 44), cemuEntry('StickL_Down', 45),
    cemuEntry('StickR_Left', 46), cemuEntry('StickR_Down', 47)
  ].join('\n'))}
</emulated_controller>
`

/**
 * Rend un émulateur directement utilisable : langue de l'app, plein écran, résolution interne ≥ 1080p (adaptée à l'écran), BIOS, manette.
 * Appelé une seule fois, à l'installation : une mise à jour ne réécrit jamais les réglages de l'utilisateur.
 */
export async function configureEmulator(id: string, dir: string, ctx: ConfigContext): Promise<void> {
  await mkdir(dir, { recursive: true })
  const fr = ctx.lang === 'fr'
  const tier = resolutionTier(ctx.displayHeight)
  switch (id) {
    case 'retroarch': {
      const cfg = join(dir, 'retroarch.cfg')
      // Les manettes sont reconnues seules (autoconfig) ; Échap quitte d'un seul appui, sans confirmation.
      await writeFile(cfg, patchCfg(await readText(cfg), {
        system_directory: ctx.biosDir, video_fullscreen: true, video_windowed_fullscreen: true, user_language: fr ? 2 : 0,
        quit_press_twice: false, input_autodetect_enable: true, input_quit_gamepad_combo: 3
      }))
      const opts = join(dir, 'retroarch-core-options.cfg')
      await writeFile(opts, patchCfg(await readText(opts), { 'mupen64plus-next-EnableNativeResFactor': pick(tier, [4, 6, 8]) }))
      return
    }
    case 'duckstation':
      return writeIni(join(dir, 'settings.ini'), {
        // Les traductions sont fournies avec l'exe (translations/duckstation-qt_fr.qm, etc.) : « Language » est sans risque, contrairement à une ancienne hypothèse.
        Main: { StartFullscreen: true, ConfirmPowerOff: false, SetupWizardIncomplete: false, Language: fr ? 'fr' : 'en' },
        GPU: { ResolutionScale: pick(tier, [5, 6, 9]) },
        BIOS: { SearchDirectory: ctx.biosDir },
        InputSources: { SDL: true },
        Pad1: { Type: 'AnalogController', ...psPad(['Keyboard/UpArrow', 'Keyboard/RightArrow', 'Keyboard/DownArrow', 'Keyboard/LeftArrow'], 'Keyboard/Enter') }
      })
    case 'dolphin':
      return configureDolphin(dir, ctx, tier)
    case 'pcsx2':
      return writeIni(join(dir, 'inis', 'PCSX2.ini'), {
        // SettingsVersion : sans lui PCSX2 juge le fichier invalide et propose de tout réinitialiser.
        UI: { SettingsVersion: 1, SetupWizardIncomplete: false, StartFullscreen: true, Language: fr ? 'fr-FR' : 'en-US', ConfirmShutdown: false },
        'EmuCore/GS': { upscale_multiplier: pick(tier, [3, 4, 6]) },
        Folders: { Bios: ctx.biosDir },
        InputSources: { SDL: true },
        Pad1: { Type: 'DualShock2', ...psPad(['Keyboard/Up', 'Keyboard/Right', 'Keyboard/Down', 'Keyboard/Left'], 'Keyboard/Return') }
      })
    case 'melonds': {
      // Fusion (pas createOnce) : un melonDS.toml partiel peut déjà exister (lancement manuel de l'utilisateur avant
      // installation via RomVault), sinon Renderer/langue/manette ne seraient jamais écrits. Touches : mêmes conventions
      // que le schéma PlayStation de ce fichier (IJKL boutons, flèches croix, Retour/Retour arrière Start/Select).
      const file = join(dir, 'melonDS.toml')
      let text = await readText(file)
      text = setTomlKeys(text, '3D', { Renderer: 1 })
      text = setTomlKeys(text, '3D.GL', { ScaleFactor: pick(tier, [6, 8, 12]) })
      text = setTomlKeys(text, 'Instance0.Firmware', { OverrideSettings: true, Language: fr ? 2 : 1 })
      // Valeurs Qt::Key (pas les codes VK de Windows) : lettres = même valeur que l'ASCII majuscule, touches spéciales
      // = 0x0100_0000 + offset (Qt::Key_Backspace=16777219, Key_Return=16777220, Key_Left=16777234, Key_Up=16777235, Key_Right=16777236, Key_Down=16777237).
      text = setTomlKeys(text, 'Instance0.Keyboard', {
        A: 76, B: 75, X: 73, Y: 74, L: 81, R: 69, Select: 16777219, Start: 16777220, Up: 16777235, Down: 16777237, Left: 16777234, Right: 16777236
      })
      await mkdir(dirname(file), { recursive: true })
      return writeFile(file, text)
    }
    case 'azahar':
      // La langue de la console (pas celle de l'appli, ci-dessous) vit dans le NAND émulé : voir `azaharCfgPath`, patchée au lancement.
      // confirmClose : sans ça, une fermeture demandée par RomVault (bouton, manette) ouvre la boîte de confirmation
      // d'Azahar au lieu de fermer — comme ConfirmStop/ConfirmPowerOff/ConfirmShutdown pour Dolphin/DuckStation/PCSX2.
      return writeIni(join(dir, 'user', 'config', 'qt-config.ini'), {
        Renderer: qt({ resolution_factor: pick(tier, [5, 7, 10]) }),
        UI: qt({ fullscreen: true, language: fr ? 'fr' : 'en', confirmClose: false }),
        Controls: { ...qt({ profile: 1, ...AZAHAR_CONTROLLER_PROFILE }), 'profiles\\size': 2 }
      }, '=')
    case 'cemu':
      // « default » (pas un GUID) : identifiant que DirectSoundAPI donne au pilote son par défaut de Windows (voir
      // DirectSoundDeviceDescription::GetIdentifier) — le seul qui ne dépend pas du matériel de la machine. Sans lui,
      // TVDevice/PadDevice vides = Cemu ne joue aucun son (IAudioAPI::CreateDeviceFromConfig renvoie null).
      // TVVolume par défaut de Cemu = 20 (sur 100) si absent : très bas, on met le plein volume.
      await createOnce(join(dir, 'settings.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<content>\n  <fullscreen>true</fullscreen>\n  <console_language>${fr ? 2 : 1}</console_language>\n  <Audio>\n    <TVVolume>100</TVVolume>\n    <TVDevice>default</TVDevice>\n    <PadDevice>default</PadDevice>\n  </Audio>\n</content>\n`)
      return createOnce(join(dir, 'controllerProfiles', 'controller0.xml'), CEMU_GAMEPAD_PROFILE)
    case 'eden':
      // confirmStop=2 (ConfirmStop::Ask_Never) : sans ça, un « Fermer le jeu » de RomVault (ou le raccourci manette
      // Retour+Start) ouvre la boîte de confirmation d'Eden au lieu de fermer — comme confirmClose pour Azahar.
      // Valeur et section (« UI », catégorie UiGeneral) vérifiées contre le code source réel d'Eden
      // (src/qt_common/config/uisettings.h, src/common/settings_enums.h, src/common/settings.cpp TranslateCategory).
      return writeIni(join(dir, 'user', 'config', 'qt-config.ini'), {
        Renderer: qt({ resolution_setup: pick(tier, [2, 3, 5]) }),
        System: qt({ language_index: fr ? 2 : 1 }),
        UI: qt({ fullscreen: true, language: fr ? 'fr' : 'en', confirmStop: 2 }),
        Controls: qt(EDEN_CONTROLLER_PROFILE)
      }, '=')
    case 'ppsspp':
      return writeIni(join(dir, 'memstick', 'PSP', 'SYSTEM', 'ppsspp.ini'), {
        General: { Language: fr ? 'fr_FR' : 'en_US' },
        SystemParam: { Language: fr ? 2 : 1 },
        // 0 = résolution automatique : celle de la fenêtre, donc de l'écran en plein écran.
        Graphics: { FullScreen: true, InternalResolution: 0 }
      })
    case 'rpcs3':
      await createOnce(join(dir, 'config', 'config.yml'), `Video:\n  Resolution Scale: ${pick(tier, [150, 200, 300])}\nSystem:\n  Language: ${fr ? 'French' : 'English (US)'}\n`)
      return writeIni(join(dir, 'config', 'GuiConfigs', 'CurrentSettings.ini'), { main_window: { startGameFullscreen: true } }, '=')
    case 'vita3k': {
      // Vita3K ignore un config.yml partiel : on le laisse créer le sien (premier démarrage), puis on en change les valeurs.
      const file = join(dir, 'config.yml')
      if (!existsSync(file)) await runOnceUntil(join(dir, 'Vita3K.exe'), dir, () => existsSync(file) && readFileSync(file, 'utf8').includes('sys-lang'))
      if (!existsSync(file)) return
      await writeFile(file, patchYaml(await readText(file), { 'sys-lang': fr ? 2 : 1, 'resolution-multiplier': pick(tier, [2, 3, 4]), 'boot-apps-full-screen': true }))
      return
    }
  }
}
