/**
 * Entrées de la bibliothèque qui ne sont pas des ROM : exécutable ajouté à la main, ou jeu d'un launcher (Steam, Epic…). Elles n'ont ni console,
 * ni hash, ni fichier à gérer : Kartouche ne fait que les lancer, et ne supprime JAMAIS leurs fichiers (ils appartiennent à l'utilisateur ou au launcher).
 */

export const ENTRY_KINDS = ['rom', 'exe', 'launcher'] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]

/** Plateforme des entrées non-ROM (valeur de `LibraryEntry.console`) : pas une console du catalogue (voir `platformLabel`). */
export const PC_PLATFORM = 'pc'

/** D'où vient une entrée non-ROM : ajout manuel, ou le launcher qui l'a fournie. */
export const GAME_SOURCES = ['manual', 'steam', 'epic', 'gog', 'hydra', 'xbox', 'ea', 'ubisoft', 'battlenet', 'itch'] as const
export type GameSource = (typeof GAME_SOURCES)[number]

export const isGameSource = (v: unknown): v is GameSource => typeof v === 'string' && (GAME_SOURCES as readonly string[]).includes(v)

/**
 * Comment lancer l'entrée. `exe` : lancer l'exécutable directement. `uri` : ouvrir l'adresse du launcher d'origine (`steam://rungameid/…`), qui démarre
 * le jeu sans autre action de l'utilisateur ; `exe` sert alors de repli si le launcher est absent.
 */
export interface LaunchSpec {
  type: 'exe' | 'uri'
  exe?: string
  args?: string
  cwd?: string
  uri?: string
  /** Dossier d'installation (jeux de launcher) : sert à savoir si le jeu est toujours installé. */
  installDir?: string
}

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined)

/** Lecture tolérante d'une spécification stockée (JSON) : null si elle ne permet de rien lancer. */
export function parseLaunchSpec(raw: unknown): LaunchSpec | null {
  let v: unknown = raw
  if (typeof raw === 'string') { try { v = JSON.parse(raw) } catch { return null } }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.type !== 'exe' && o.type !== 'uri') return null
  const spec: LaunchSpec = { type: o.type }
  const exe = text(o.exe, 520); if (exe) spec.exe = exe
  const args = text(o.args, 2000); if (args) spec.args = args
  const cwd = text(o.cwd, 520); if (cwd) spec.cwd = cwd
  const uri = text(o.uri, 2000); if (uri) spec.uri = uri
  const installDir = text(o.installDir, 520); if (installDir) spec.installDir = installDir
  if (spec.type === 'exe' && !spec.exe) return null
  if (spec.type === 'uri' && !spec.uri) return null
  return spec
}

/** Chemin dont l'existence dit si le jeu est toujours là (l'exécutable, sinon le dossier d'installation) ; null = on ne sait pas. */
export const launchCheckPath = (spec: LaunchSpec): string | null => spec.exe ?? spec.installDir ?? null
