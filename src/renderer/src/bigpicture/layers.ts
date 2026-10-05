import type { PadAction } from './nav'

/**
 * Couches superposées à la fiche du Big Picture (bande-annonce, captures) : la plus récente reçoit d'abord chaque action de la manette ou du clavier.
 * Elle renvoie vrai si elle l'a traitée (ex. B ferme la couche) ; sinon l'action continue vers la fiche (B la ferme à son tour).
 * Un seul `useNav` reste actif (voir useNav.ts) : les couches passent par celui de BigPicture.tsx, sans jamais en ouvrir un second.
 */
export type LayerHandler = (a: PadAction) => boolean

const stack: LayerHandler[] = []

/** Ajoute une couche ; renvoie la fonction qui la retire (à appeler au démontage). */
export function pushLayer(handler: LayerHandler): () => void {
  stack.push(handler)
  return () => { const i = stack.lastIndexOf(handler); if (i >= 0) stack.splice(i, 1) }
}

/** Transmet l'action à la couche du dessus ; faux s'il n'y en a pas ou si elle ne la traite pas. */
export function dispatchToLayer(a: PadAction): boolean {
  const top = stack[stack.length - 1]
  return top ? top(a) : false
}

export const hasLayer = (): boolean => stack.length > 0
