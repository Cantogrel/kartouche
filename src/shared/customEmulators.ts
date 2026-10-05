import { CONSOLES } from './consoles'

/**
 * Émulateurs ajoutés par l'utilisateur (hors de la liste installable depuis l'app). Kartouche ne les installe, ne les met pas à jour et n'écrit
 * aucune configuration chez eux : il les lance avec les arguments donnés, c'est tout.
 */
export interface CustomEmulator {
  /** `custom-<n>` : jamais l'identifiant d'un émulateur intégré. */
  id: string
  name: string
  /** Chemin de l'exécutable. */
  exe: string
  /** Modèle d'arguments : `{rom}` chemin du fichier, `{dir}` son dossier, `{file}` son nom, `{name}` son nom sans extension, `{console}` identifiant de la console. */
  args: string
  /** Consoles du catalogue que cet émulateur sait lancer. */
  consoles: string[]
  /** Extensions de fichier (sans point, en minuscules) qu'il sait ouvrir ; vide = toutes celles de ses consoles. */
  extensions: string[]
}

export const CUSTOM_ID_PREFIX = 'custom-'
export const isCustomEmulatorId = (id: string | null | undefined): boolean => typeof id === 'string' && /^custom-\d+$/.test(id)

export const DEFAULT_CUSTOM_ARGS = '"{rom}"'
const EXE_EXT = /\.(exe|bat|cmd)$/i

export type CustomEmulatorError = 'name' | 'exe' | 'args' | 'consoles' | 'extensions'
export type CustomEmulatorInput = Omit<CustomEmulator, 'id'>

/** Valide et nettoie ce que l'utilisateur a saisi ; renvoie le premier champ en défaut. */
export function validateCustomEmulator(raw: unknown): { ok: true; value: CustomEmulatorInput } | { ok: false; error: CustomEmulatorError } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const name = str(o.name)
  if (!name || name.length > 60) return { ok: false, error: 'name' }
  const exe = str(o.exe)
  if (!exe || exe.length > 520 || !EXE_EXT.test(exe) || /[\0<>"|?*]/.test(exe)) return { ok: false, error: 'exe' }
  const args = typeof o.args === 'string' ? o.args.trim() : DEFAULT_CUSTOM_ARGS
  if (args.length > 2000 || args.includes('\0')) return { ok: false, error: 'args' }
  const known = new Set(CONSOLES.map((c) => c.id))
  const consoles = [...new Set(Array.isArray(o.consoles) ? o.consoles.filter((c): c is string => typeof c === 'string') : [])]
  if (consoles.some((c) => !known.has(c))) return { ok: false, error: 'consoles' }
  const extensions = [...new Set((Array.isArray(o.extensions) ? o.extensions : []).map((e) => str(e).replace(/^\./, '').toLowerCase()).filter(Boolean))]
  if (extensions.length > 40 || extensions.some((e) => !/^[a-z0-9]{1,10}$/.test(e))) return { ok: false, error: 'extensions' }
  return { ok: true, value: { name, exe, args: args || DEFAULT_CUSTOM_ARGS, consoles, extensions } }
}

/** Découpe un modèle d'arguments comme une ligne de commande : les guillemets doubles groupent (un chemin avec espaces reste un seul argument). */
export function splitArgs(template: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let has = false
  for (const ch of template) {
    if (ch === '"') { quoted = !quoted; has = true }
    else if (!quoted && /\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false } }
    else { cur += ch; has = true }
  }
  if (has) out.push(cur)
  return out
}

export interface CommandVars { rom?: string; console?: string }

const lastSep = (p: string): number => Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))

/**
 * Ligne de commande d'un lancement : l'exécutable et ses arguments. Les variables sont remplacées argument par argument APRÈS le découpage, donc un
 * chemin avec espaces ou guillemets ne peut jamais se scinder ni injecter un argument.
 */
export function buildCustomCommand(emu: Pick<CustomEmulator, 'exe' | 'args'>, vars: CommandVars): { exe: string; args: string[] } {
  const rom = vars.rom ?? ''
  const cut = lastSep(rom)
  const file = cut >= 0 ? rom.slice(cut + 1) : rom
  const dot = file.lastIndexOf('.')
  const values: Record<string, string> = { rom, dir: cut >= 0 ? rom.slice(0, cut) : '', file, name: dot > 0 ? file.slice(0, dot) : file, console: vars.console ?? '' }
  return { exe: emu.exe, args: splitArgs(emu.args).map((a) => a.replace(/\{(rom|dir|file|name|console)\}/g, (_m, k: string) => values[k])) }
}

/** Texte affiché pour montrer la commande qui sera lancée (guillemets autour de ce qui contient des espaces). */
export function formatCommand(cmd: { exe: string; args: string[] }): string {
  const q = (s: string): string => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
  return [cmd.exe, ...cmd.args].map(q).join(' ')
}

/** Cet émulateur peut-il lancer ce fichier ? Console gérée, et extension acceptée (toutes si la liste est vide). */
export function customEmulatorAccepts(emu: Pick<CustomEmulator, 'consoles' | 'extensions'>, consoleId: string, file: string): boolean {
  if (!emu.consoles.includes(consoleId)) return false
  if (emu.extensions.length === 0) return true
  const dot = file.lastIndexOf('.')
  return dot >= 0 && emu.extensions.includes(file.slice(dot + 1).toLowerCase())
}

/** Émulateur personnalisé avec l'état de son exécutable (`missing` : le fichier n'existe plus). */
export type CustomEmulatorState = CustomEmulator & { missing: boolean }

export type SaveEmulatorResult = { ok: true; id: string } | { ok: false; error: CustomEmulatorError | 'notFound' }
