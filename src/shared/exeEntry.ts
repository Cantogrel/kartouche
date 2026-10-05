/** Ajout d'exécutables locaux comme jeux (voir main/library/addExe.ts). */

export interface AddExeResult {
  /** Entrées créées. */
  added: number[]
  /** Entrées déjà présentes (même exécutable). */
  existing: number[]
  /** Chemins refusés : ni .exe/.bat/.cmd/.lnk, introuvables ou raccourci sans cible. */
  invalid: string[]
}

const EXTENSIONS = ['exe', 'bat', 'cmd'] as const
export const EXE_PICK_EXTENSIONS = [...EXTENSIONS, 'lnk']

const ext = (p: string): string => { const m = /\.([A-Za-z0-9]+)$/.exec(p); return m ? m[1].toLowerCase() : '' }

/** Exécutable lançable (le raccourci .lnk est résolu avant). */
export const isExecutablePath = (p: string): boolean => (EXTENSIONS as readonly string[]).includes(ext(p))
/** Fichier qu'on sait ajouter : exécutable ou raccourci. */
export const isAddablePath = (p: string): boolean => isExecutablePath(p) || ext(p) === 'lnk'

/** Titre proposé pour un exécutable : nom du fichier sans extension, séparateurs remplacés par des espaces, camelCase éclaté (MonJeu → Mon Jeu). */
export function exeTitleFromPath(p: string): string {
  const file = p.split(/[\\/]/).pop() ?? p
  const base = file.replace(/\.[A-Za-z0-9]+$/, '')
  const spaced = base.replace(/[_.]+/g, ' ').replace(/-+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim()
  return spaced || base
}
