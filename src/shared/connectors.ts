import { isGameSource, type GameSource, type LaunchSpec } from './launch'

/**
 * Connecteurs de launchers (Steam, Epic, GOG…) : chacun LIT la liste des jeux installés dans les fichiers locaux du launcher et ne renvoie que des
 * jeux détectés. Règle de sécurité commune : un connecteur ne lit jamais d'identifiant, de jeton, de mot de passe ni de session du compte de
 * l'utilisateur, et ne contacte aucun service du launcher ; seulement des manifestes de jeux (nom, identifiant, dossier, exécutable).
 */

/** Jeu détecté dans un launcher, avant d'entrer dans la bibliothèque. */
export interface DetectedGame {
  /** Identifiant chez le launcher (appid Steam, AppName Epic…) : clé de dédoublonnage. */
  nativeId: string
  title: string
  /** Dossier d'installation. */
  installDir?: string
  /** Exécutable principal : repli de lancement si le launcher est absent. */
  exe?: string
  args?: string
  cwd?: string
  /** Adresse qui fait démarrer le jeu par le launcher (`steam://rungameid/…`) ; schémas autorisés : LAUNCH_URI_SCHEMES. */
  uri?: string
}

/** Schémas d'adresse que Kartouche accepte d'ouvrir pour lancer un jeu : ceux des launchers pris en charge, jamais `file:`, `http:` ni `javascript:`. */
export const LAUNCH_URI_SCHEMES = ['steam', 'com.epicgames.launcher', 'goggalaxy', 'uplay', 'battlenet', 'origin2', 'origin', 'eadesktop', 'itch', 'ms-xbl-', 'msxbox'] as const

export function isLaunchUri(uri: string): boolean {
  // Application du menu Démarrer d'un jeu Xbox / Microsoft Store : `shell:AppsFolder\<paquet>!<application>`, rien d'autre sous `shell:`.
  if (/^shell:AppsFolder\\[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/i.test(uri.trim())) return true
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(uri.trim())
  if (!m) return false
  const scheme = m[1].toLowerCase()
  return LAUNCH_URI_SCHEMES.some((s) => scheme === s || (s.endsWith('-') && scheme.startsWith(s)))
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined)

/** Nettoie un jeu détecté (sortie d'un connecteur, donc non fiable) : null s'il ne permet ni de l'identifier ni de le lancer. */
export function sanitizeDetected(raw: unknown): DetectedGame | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const nativeId = str(o.nativeId, 200)
  const title = str(o.title, 200)
  if (!nativeId || !title) return null
  const game: DetectedGame = { nativeId, title }
  const installDir = str(o.installDir, 520); if (installDir) game.installDir = installDir
  const exe = str(o.exe, 520); if (exe) game.exe = exe
  const args = str(o.args, 2000); if (args) game.args = args
  const cwd = str(o.cwd, 520); if (cwd) game.cwd = cwd
  const uri = str(o.uri, 2000); if (uri && isLaunchUri(uri)) game.uri = uri
  return game.exe || game.uri ? game : null
}

/** Spécification de lancement d'un jeu détecté : l'adresse du launcher d'abord (démarrage automatique), l'exécutable en repli. */
export function launchSpecOf(g: DetectedGame): LaunchSpec {
  const spec: LaunchSpec = g.uri ? { type: 'uri', uri: g.uri } : { type: 'exe', exe: g.exe }
  if (g.uri && g.exe) spec.exe = g.exe
  if (g.args) spec.args = g.args
  if (g.cwd) spec.cwd = g.cwd
  if (g.installDir) spec.installDir = g.installDir
  return spec
}

/** État d'un launcher affiché dans Paramètres → Launchers. */
export interface ConnectorStatus {
  id: GameSource
  name: string
  /** Le launcher est installé sur ce PC (ses fichiers ont été trouvés) ; `null` = pas encore vérifié (la détection tourne en arrière-plan). */
  detected: boolean | null
  enabled: boolean
  /** Jeux de ce launcher actuellement dans la bibliothèque. */
  games: number
}

export interface ScanReport {
  id: GameSource
  /** Faux si le launcher est absent ou si sa lecture a échoué. */
  ok: boolean
  error?: string
  found: number
  added: number
  updated: number
  /** Jeux déjà présents ailleurs (même dossier ou exécutable déjà dans la bibliothèque). */
  duplicates: number
  /** Jeux de ce launcher qui ne sont plus détectés (désinstallés) : conservés, marqués sans fichier. */
  gone: number
}

export const isConnectorId = (v: unknown): v is GameSource => isGameSource(v) && v !== 'manual'
