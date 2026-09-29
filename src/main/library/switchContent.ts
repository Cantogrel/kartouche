export type SwitchContentKind = 'base' | 'update' | 'dlc'
/** baseTitleId vide = inconnu (dump sans Title ID lisible, classé par mot-clé) : voir `findSwitchBase` dans importer.ts. */
export interface SwitchContent { kind: SwitchContentKind; titleId: string; baseTitleId: string }

/** Title ID (16 chiffres hexa) entre crochets ou parenthèses, convention des dumps NSP/XCI (nxdumptool, No-Intro). */
const TITLE_ID_RE = /[[(]([0-9A-Fa-f]{16})[\])]/
/** Mots-clés des dumps qui n'ont pas de Title ID dans leur nom (ex. « Super Smash Bros. Ultimate Switch NSP Update v2031616.nsp »). */
const UPDATE_WORD_RE = /\bupdate\b/i
const DLC_WORD_RE = /\bdlc\b|\badd[- ]?on\b/i

/**
 * Type de contenu Switch d'après son Title ID : un jeu de base finit par `000`, sa mise à jour a le même Title ID
 * avec le bit `0x800` posé (finit par `800`), un DLC a le 4e chiffre hexa en partant de la fin incrémenté de 1
 * (toujours impair) et les 3 derniers chiffres variables (index du DLC). Exemple (Breath of the Wild) :
 * base `…11E000`, mise à jour `…11E800`, DLC `…11F001`/`…11F002`.
 */
export function classifySwitchTitleId(id: string): SwitchContent {
  const hex = id.toUpperCase()
  const tail = parseInt(hex.slice(-4), 16)
  const nibble4 = (tail >> 12) & 0xf
  const low3 = tail & 0xfff
  const withTail = (nib: number): string => `${hex.slice(0, -4)}${nib.toString(16).toUpperCase()}000`
  if (low3 === 0) return { kind: 'base', titleId: hex, baseTitleId: hex }
  if (low3 === 0x800) return { kind: 'update', titleId: hex, baseTitleId: withTail(nibble4) }
  return { kind: 'dlc', titleId: hex, baseTitleId: withTail(nibble4 % 2 === 1 ? nibble4 - 1 : nibble4) }
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
