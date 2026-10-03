export type SwitchContentKind = 'base' | 'update' | 'dlc'
/** baseTitleId vide = inconnu (dump sans Title ID lisible, classé par mot-clé) : voir `findSwitchBase` dans importer.ts. */
export interface SwitchContent { kind: SwitchContentKind; titleId: string; baseTitleId: string }

/** Title ID (16 chiffres hexa) entre crochets ou parenthèses, convention des dumps NSP/XCI (nxdumptool, No-Intro). */
const TITLE_ID_RE = /[[(]([0-9A-Fa-f]{16})[\])]/
/** Mots-clés des dumps qui n'ont pas de Title ID dans leur nom (ex. « Super Smash Bros. Ultimate Switch NSP Update v2031616.nsp »). */
const UPDATE_WORD_RE = /\bupdate\b/i
const DLC_WORD_RE = /\bdlc\b|\badd[- ]?on\b/i

/**
 * Type de contenu Switch d'après son Title ID, avec la règle d'Eden/Yuzu (`GetBaseTitleID` : on masque les 13 bits bas) : un jeu de base a
 * ces 13 bits à 0, sa mise à jour vaut base | 0x800, un DLC a le bit 0x1000 posé et un index dans les bits restants. Exemples (Breath of
 * the Wild) : base `…11E000`, mise à jour `…11E800`, DLC `…11F001`/`…11F002`. Null pour un identifiant qui ne suit aucun des trois motifs.
 */
export function classifySwitchTitleId(id: string): SwitchContent | null {
  const hex = id.toUpperCase()
  if (!/^[0-9A-F]{16}$/.test(hex)) return null
  const n = BigInt(`0x${hex}`)
  const low = Number(n & 0x1fffn)
  const base = (n & ~0x1fffn).toString(16).padStart(16, '0').toUpperCase()
  if (low === 0) return { kind: 'base', titleId: hex, baseTitleId: hex }
  if (low === 0x800) return { kind: 'update', titleId: hex, baseTitleId: base }
  if (low & 0x1000) return { kind: 'dlc', titleId: hex, baseTitleId: base }
  return null
}

/**
 * Extrait et classe le Title ID d'un nom de fichier Switch. À défaut (dump sans Title ID lisible), retombe sur les
 * mots « update »/« DLC » du nom ; le jeu de base est alors retrouvé par le nom plutôt que le Title ID (voir
 * `findSwitchBase` dans importer.ts) — moins fiable, mais c'est le seul indice disponible pour ces dumps-là.
 */
export function switchContentFromFilename(name: string): SwitchContent | null {
  const m = TITLE_ID_RE.exec(name)
  if (m) return classifySwitchTitleId(m[1])
  if (UPDATE_WORD_RE.test(name)) return { kind: 'update', titleId: '', baseTitleId: '' }
  if (DLC_WORD_RE.test(name)) return { kind: 'dlc', titleId: '', baseTitleId: '' }
  return null
}
