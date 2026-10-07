import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GpuTier, Gpu } from './gpu'

// Configuration automatique de Cemu : réglages graphiques selon le GPU, résolution par graphic packs, manette Pro Controller
// (profil GamePad pour les jeux qui l'exigent). Cemu lit `settings.xml` posé à côté de son exe en mode portable (CemuApp::DeterminePaths) :
// c'est aussi ce qui évite sa boîte de premier démarrage. Toute la logique est ici pour ne pas alourdir configure.ts.

/** Plafond de résolution interne (hauteur) : l'écran, borné par ce que le GPU tient sans surchauffer. L'iGPU reste en natif (720p). */
const TIER_MAX_HEIGHT: Record<GpuTier, number> = { igpu: 720, low: 1080, mid: 1440, high: 2160 }
export const maxRenderHeight = (gpu: Gpu, displayHeight: number): number => Math.min(TIER_MAX_HEIGHT[gpu.tier], Math.max(720, displayHeight))

// --- settings.xml -------------------------------------------------------------------------------------------------------

/**
 * Réglages écrits une seule fois. Langue console : CafeConsoleLanguage (1 anglais, 2 français). Audio « default » : identifiant que
 * DirectSoundAPI donne au pilote son par défaut de Windows (sans lui Cemu reste muet) ; TVVolume vaut 20 sur 100 si absent. `api` 0 = DirectSound, épinglé car « default » n'a de sens que pour lui : il suit
 * le périphérique par défaut de Windows même s'il change ensuite, sans mode exclusif. Latence (`delay`) laissée à la valeur par défaut de Cemu.
 * Graphic : api 1 = Vulkan, 0 = OpenGL ; périphérique Vulkan laissé absent (= automatique) ; compilation asynchrone des shaders.
 */
export function cemuSettingsXml(fr: boolean, gpu: Gpu): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<content>
  <fullscreen>true</fullscreen>
  <console_language>${fr ? 2 : 1}</console_language>
  <Graphic>
    <api>${gpu.vulkan ? 1 : 0}</api>
    <AsyncCompile>true</AsyncCompile>
  </Graphic>
  <Audio>
    <api>0</api>
    <TVVolume>100</TVVolume>
    <TVDevice>default</TVDevice>
    <PadDevice>default</PadDevice>
  </Audio>
</content>
`
}

const xmlEsc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// --- Graphic packs de résolution ----------------------------------------------------------------------------------------

const PACKS_REL = 'graphicPacks/downloadedGraphicPacks'

export interface RulesInfo { titleIds: string[]; name: string; presets: { name: string; category: string }[] }

/** Lit un rules.txt de graphic pack : [Definition] (titleIds, name) et les blocs [Preset] (name, category). */
export function parseRules(text: string): RulesInfo {
  const info: RulesInfo = { titleIds: [], name: '', presets: [] }
  let section = ''
  let preset: { name: string; category: string } | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      section = sec[1].toLowerCase()
      preset = section === 'preset' ? { name: '', category: '' } : null
      if (preset) info.presets.push(preset)
      continue
    }
    const kv = /^([^#=$][^=]*?)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    if (section === 'definition') {
      if (key === 'titleids') info.titleIds = kv[2].split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
      else if (key === 'name') info.name = kv[2].trim()
    } else if (preset) {
      if (key === 'name') preset.name = kv[2].trim()
      else if (key === 'category') preset.category = kv[2].trim()
    }
  }
  return info
}

/**
 * Preset de résolution d'un pack : le plus grand en 16:9 strictement au-dessus de 720p (le natif Wii U) sans dépasser `maxHeight`.
 * Deux formes existent dans les packs officiels : catégorie « Resolution » (packs « Graphics ») ou pack nommé « Resolution » sans catégorie.
 * Renvoie null si le pack n'est pas un pack de résolution ou si rien n'entre dans le plafond.
 */
export function pickResolutionPreset(info: RulesInfo, maxHeight: number): { category: string; preset: string } | null {
  if (!info.titleIds.length) return null
  const byCategory = info.presets.filter((p) => /^(tv )?resolution$/i.test(p.category))
  const candidates = byCategory.length ? byCategory : /resolution/i.test(info.name) ? info.presets.filter((p) => !p.category) : []
  let best: { h: number; p: { name: string; category: string } } | null = null
  for (const p of candidates) {
    const m = /^(\d{3,5})x(\d{3,5})/.exec(p.name)
    if (!m) continue
    const w = Number(m[1]); const h = Number(m[2])
    if (Math.abs(w / h - 16 / 9) > 0.02 || h <= 720 || h > maxHeight) continue
    if (!best || h > best.h) best = { h, p }
  }
  return best ? { category: best.p.category, preset: best.p.name } : null
}

export interface PackEntry { rules: string; category: string; preset: string; key: string; performance: boolean }

async function findRules(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...await findRules(dir, r))
    else if (e.name.toLowerCase() === 'rules.txt') out.push(r)
  }
  return out
}

/** Packs de résolution applicables, un seul par jeu (deux packs de résolution d'un même titre se marchent dessus : on garde celui qui n'est pas « Performance »). */
export async function resolutionPackEntries(packsDir: string, maxHeight: number): Promise<PackEntry[]> {
  const byGame = new Map<string, PackEntry>()
  for (const rules of (await findRules(packsDir)).sort()) {
    const info = parseRules(await readFile(join(packsDir, rules), 'utf8').catch(() => ''))
    const pick = pickResolutionPreset(info, maxHeight)
    if (!pick) continue
    const key = [...info.titleIds].sort().join(',')
    const entry: PackEntry = { rules, ...pick, key, performance: /performance/i.test(rules) }
    const prev = byGame.get(key)
    if (!prev || (prev.performance && !entry.performance)) byGame.set(key, entry)
  }
  return [...byGame.values()]
}

/** Ajoute un bloc `<GraphicPack>` (entrées de packs activés, preset de résolution choisi) à un settings.xml qui n'en a pas : un choix existant n'est jamais écrasé. */
export function addGraphicPackEntries(settings: string, entries: readonly PackEntry[]): string {
  if (!entries.length || /<GraphicPack>/.test(settings)) return settings
  const block = entries.map((e) => `    <Entry filename="${xmlEsc(`${PACKS_REL}/${e.rules}`)}"><Preset>${e.category ? `<category>${xmlEsc(e.category)}</category>` : ''}<preset>${xmlEsc(e.preset)}</preset></Preset></Entry>`).join('\n')
  return settings.replace('</content>', `  <GraphicPack>\n${block}\n  </GraphicPack>\n</content>`)
}

export interface PackDeps {
  download: (url: string, file: string) => Promise<void>
  extract: (archive: string, dest: string) => Promise<void>
  cache: string
}

/**
 * Télécharge les graphic packs officiels (cemu-project/cemu_graphic_packs, dernière release) puis active le preset de résolution
 * de chaque jeu pris en charge. Facultatif : toute erreur (réseau…) laisse Cemu fonctionnel en 720p natif.
 */
export async function installResolutionPacks(dir: string, maxHeight: number, deps: PackDeps): Promise<number> {
  if (maxHeight <= 720) return 0
  const settingsFile = join(dir, 'settings.xml')
  const settings = await readFile(settingsFile, 'utf8').catch(() => '')
  if (!settings || /<GraphicPack>/.test(settings)) return 0
  const rel = await fetch('https://api.github.com/repos/cemu-project/cemu_graphic_packs/releases/latest', { headers: { 'user-agent': 'Kartouche' }, signal: AbortSignal.timeout(15000) }).then((r) => r.json()) as { assets?: { name: string; browser_download_url: string }[] }
  const asset = rel.assets?.find((a) => /^graphicPacks\d+\.zip$/.test(a.name))
  if (!asset) return 0
  const packs = join(dir, ...PACKS_REL.split('/'))
  await mkdir(join(dir, 'graphicPacks'), { recursive: true })
  const zip = join(deps.cache, asset.name)
  await mkdir(deps.cache, { recursive: true })
  await deps.download(asset.browser_download_url, zip)
  await rm(packs, { recursive: true, force: true })
  await mkdir(packs, { recursive: true })
  await deps.extract(zip, packs)
  await rm(zip, { force: true })
  await writeFile(join(packs, 'version.txt'), asset.name.replace(/\D/g, ''))
  const entries = await resolutionPackEntries(packs, maxHeight)
  await writeFile(settingsFile, addGraphicPackEntries(settings, entries))
  return entries.length
}

// --- Manettes -----------------------------------------------------------------------------------------------------------

export type PadKind = 'pro' | 'gamepad'

/** Identifiants `<mapping>` de Cemu (ProController.h / VPADController.h) : stables depuis la création des enums. */
const IDS: Record<PadKind, Record<string, number>> = {
  gamepad: {
    A: 1, B: 2, X: 3, Y: 4, L: 5, R: 6, ZL: 7, ZR: 8, Plus: 9, Minus: 10, Up: 11, Down: 12, Left: 13, Right: 14,
    StickL: 15, StickR: 16, StickL_Up: 17, StickL_Down: 18, StickL_Left: 19, StickL_Right: 20,
    StickR_Up: 21, StickR_Down: 22, StickR_Left: 23, StickR_Right: 24, Home: 27
  },
  pro: {
    A: 1, B: 2, X: 3, Y: 4, L: 5, R: 6, ZL: 7, ZR: 8, Plus: 9, Minus: 10, Home: 11, Up: 12, Down: 13, Left: 14, Right: 15,
    StickL: 16, StickR: 17, StickL_Up: 18, StickL_Down: 19, StickL_Left: 20, StickL_Right: 21,
    StickR_Up: 22, StickR_Down: 23, StickR_Left: 24, StickR_Right: 25
  }
}

/** Clavier (codes de touche wx = VK Windows) : IJKL boutons, WASD stick gauche, THGF stick droit, flèches croix — comme les autres émulateurs de Kartouche. */
const KEYBOARD: Record<string, number> = {
  A: 76, B: 75, X: 73, Y: 74, L: 81, R: 69, ZL: 49, ZR: 51, Plus: 13, Minus: 8, Up: 38, Down: 40, Left: 37, Right: 39, StickL: 50, StickR: 52,
  StickL_Up: 87, StickL_Down: 83, StickL_Left: 65, StickL_Right: 68, StickR_Up: 84, StickR_Down: 71, StickR_Left: 70, StickR_Right: 72, Home: 27
}

/** Table par défaut de Cemu pour XInput (set_default_mapping) : kButton0..15 = boutons, kAxis/kRotation/kTrigger = sticks/gâchettes. Pas de Home : XInput ne remonte pas le bouton Guide. */
const XINPUT: Record<string, number> = {
  Up: 0, Down: 1, Left: 2, Right: 3, Plus: 4, Minus: 5, StickL: 6, StickR: 7, L: 8, R: 9, B: 12, A: 13, Y: 14, X: 15,
  StickL_Right: 38, StickL_Up: 39, StickR_Right: 40, StickR_Up: 41, ZL: 42, ZR: 43, StickL_Left: 44, StickL_Down: 45, StickR_Left: 46, StickR_Down: 47
}

const TYPE_NAME: Record<PadKind, string> = { gamepad: 'Wii U GamePad', pro: 'Wii U Pro Controller' }
const MARKER = /<!--\s*romvault:cemu-profile=(gamepad|pro)\s*-->/

const controllerBlock = (kind: PadKind, api: string, uuid: string, displayName: string, deadzone: number, table: Record<string, number>): string => {
  const entries = Object.entries(table).map(([control, physical]) => `      <entry><mapping>${IDS[kind][control]}</mapping><button>${physical}</button></entry>`).join('\n')
  return `    <controller>
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
}

/**
 * Profil du Pad 1 : clavier + 1ère manette XInput (identifiants génériques de Cemu, valides même sans manette branchée). La souris sert
 * de doigt sur l'écran tactile du GamePad (natif Cemu, pas de mapping). Un commentaire marque le fichier comme écrit par Kartouche : Cemu
 * le réécrit sans ce commentaire dès que l'utilisateur retouche ses réglages, et Kartouche n'y touche alors plus jamais.
 */
export function cemuProfileXml(kind: PadKind, xinputSlot = 0): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- romvault:cemu-profile=${kind} -->
<emulated_controller>
  <type>${TYPE_NAME[kind]}</type>${kind === 'gamepad' ? '\n  <toggle_display>0</toggle_display>' : ''}
${controllerBlock(kind, 'Keyboard', 'keyboard', 'Keyboard', 0.25, Object.fromEntries(Object.keys(IDS[kind]).map((c) => [c, KEYBOARD[c]])))}
${controllerBlock(kind, 'XInput', String(xinputSlot), 'Controller 1', 0.15, Object.fromEntries(Object.keys(XINPUT).map((c) => [c, XINPUT[c]])))}
</emulated_controller>
`
}

/**
 * Manette XInput du profil Kartouche : l'emplacement de celle qu'on utilise (Sunshine en ajoute de virtuelles, la première n'est pas forcément la bonne).
 * Un profil retouché par l'utilisateur (marqueur disparu) n'est jamais touché.
 */
export async function applyCemuPad(dir: string, xinputSlot: number): Promise<void> {
  const file = join(dir, 'controllerProfiles', 'controller0.xml')
  const current = await readFile(file, 'utf8').catch(() => null)
  if (current === null || !MARKER.test(current)) return
  const next = current.replace(/(<api>XInput<\/api>\s*<uuid>)\d(<\/uuid>)/, `$1${xinputSlot}$2`)
  if (next !== current) await writeFile(file, next)
}

/**
 * Jeux qui exigent réellement le GamePad (écran tactile, gyroscope, second écran) : un Pro Controller les rend injouables ou
 * incomplets. Reconnus par leur titre (normalisé : minuscules, sans accents ni ponctuation). Liste faite pour s'étendre : ajouter
 * une ligne `{ title: /…/, why: '…' }` suffit.
 */
export const GAMEPAD_REQUIRED: readonly { title: RegExp; why: string }[] = [
  { title: /nintendo land/, why: 'attractions asymétriques sur écran tactile' },
  { title: /zombiu/, why: 'inventaire et scanner sur le GamePad' },
  { title: /game (and|&) wario|game wario/, why: 'jeux tactiles et gyroscope' },
  { title: /star fox (zero|guard)/, why: 'visée gyroscopique, second écran' },
  { title: /super mario maker/, why: 'éditeur de niveaux tactile' },
  { title: /mario party 10/, why: 'mode Bowser sur le GamePad' },
  { title: /captain toad/, why: 'niveaux tactiles et gyroscope' },
  { title: /kirby and the rainbow (curse|paintbrush)|kirby et le pinceau/, why: 'jouable uniquement au stylet' },
  { title: /wii fit u/, why: 'GamePad et balance board' },
  { title: /art academy|drawn to life/, why: 'dessin au stylet' },
  { title: /wii party u|wii karaoke u/, why: 'écran du GamePad' }
]

const normTitle = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim()

/** Vrai si l'un des noms (titre de la bibliothèque, nom du fichier) correspond à un jeu qui exige le GamePad. */
export const needsGamePad = (...names: string[]): boolean => names.some((n) => GAMEPAD_REQUIRED.some((g) => g.title.test(normTitle(n))))

/** Profils nommés « Kartouche … » dans le dossier des profils : chargeables à la main depuis les réglages de manettes de Cemu. Créés une fois, jamais modifiés. */
export async function writeCemuProfiles(dir: string): Promise<void> {
  const profiles = join(dir, 'controllerProfiles')
  await mkdir(profiles, { recursive: true })
  for (const [kind, name] of [['pro', 'RomVault Pro Controller'], ['gamepad', 'RomVault GamePad']] as const) {
    const file = join(profiles, `${name}.xml`)
    if (!existsSync(file)) await writeFile(file, cemuProfileXml(kind))
  }
}

/**
 * Choisit le profil du Pad 1 au lancement d'un jeu : Pro Controller par défaut, GamePad pour les jeux de `GAMEPAD_REQUIRED`.
 * Ne touche que le fichier absent ou encore marqué Kartouche ; un profil retouché par l'utilisateur (marqueur disparu) est laissé tel quel.
 */
export async function applyCemuControls(dir: string, ...names: string[]): Promise<void> {
  const file = join(dir, 'controllerProfiles', 'controller0.xml')
  const current = await readFile(file, 'utf8').catch(() => null)
  const marked = current === null ? null : MARKER.exec(current)?.[1] ?? 'user'
  if (marked === 'user') return
  const wanted: PadKind = needsGamePad(...names) ? 'gamepad' : 'pro'
  if (marked === wanted) return
  await mkdir(join(dir, 'controllerProfiles'), { recursive: true })
  await writeFile(file, cemuProfileXml(wanted))
}
