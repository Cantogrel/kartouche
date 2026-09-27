/** Navigation par focus (manette / clavier) : choix de l'élément voisin dans une direction et lecture des boutons de la manette. */

export type Dir = 'up' | 'down' | 'left' | 'right'
export type PadAction = Dir | 'accept' | 'back' | 'x' | 'y' | 'prev' | 'next' | 'prevFilter' | 'nextFilter' | 'start'
export interface Box { x: number; y: number; w: number; h: number }

const center = (b: Box): { cx: number; cy: number } => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 })

/**
 * Indice du voisin le plus adapté dans la direction demandée, -1 s'il n'y en a pas.
 * Un candidat doit être du bon côté (centre à l'avant du centre courant) ; le score favorise la distance sur l'axe
 * puis pénalise le décalage latéral, ce qui garde le curseur dans sa colonne / sa ligne.
 */
export function pickNext(cur: Box, others: Box[], dir: Dir): number {
  const c = center(cur)
  let best = -1
  let bestScore = Infinity
  others.forEach((o, i) => {
    const p = center(o)
    const dx = p.cx - c.cx
    const dy = p.cy - c.cy
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy
    if (along <= 1) return
    const across = Math.abs(dir === 'left' || dir === 'right' ? dy : dx)
    const score = along + across * 3
    if (score < bestScore) { bestScore = score; best = i }
  })
  return best
}

export interface PadLike { buttons: ArrayLike<{ pressed: boolean }>; axes: ArrayLike<number> }

const BUTTONS: [number, PadAction][] = [
  [0, 'accept'], [1, 'back'], [2, 'x'], [3, 'y'], [4, 'prev'], [5, 'next'], [6, 'prevFilter'], [7, 'nextFilter'], [9, 'start'],
  [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']
]
const STICK = 0.6

/** Actions maintenues à cet instant (croix directionnelle ou stick gauche, boutons du profil « standard »). */
export function heldActions(pad: PadLike, opts: { swapAB?: boolean; threshold?: number } = {}): Set<PadAction> {
  const out = new Set<PadAction>()
  const stick = opts.threshold ?? STICK
  for (const [i, a] of BUTTONS) {
    const act = opts.swapAB && i < 2 ? BUTTONS[1 - i][1] : a
    if (pad.buttons[i]?.pressed) out.add(act)
  }
  const ax = pad.axes[0] ?? 0
  const ay = pad.axes[1] ?? 0
  if (ax > stick) out.add('right'); else if (ax < -stick) out.add('left')
  if (ay > stick) out.add('down'); else if (ay < -stick) out.add('up')
  return out
}

/** Défilement à appliquer (pixels) pour le stick droit (axe 3, vertical) de la première manette qui le sort de sa zone morte. */
export function rightStickScroll(pads: Iterable<PadLike | null>, deadzone: number, speed: number): number {
  let ay = 0
  for (const pad of pads) { const v = pad?.axes[3] ?? 0; if (Math.abs(v) > Math.abs(ay)) ay = v }
  return Math.abs(ay) > deadzone ? ay * speed : 0
}

const DIRS: PadAction[] = ['up', 'down', 'left', 'right']

/** Transforme l'état maintenu en évènements : un par appui, et une répétition des directions en maintien. */
export class Repeater {
  private since = new Map<PadAction, number>()
  private last = new Map<PadAction, number>()
  constructor(private delay = 400, private every = 110) {}

  update(held: Set<PadAction>, now: number): PadAction[] {
    const fired: PadAction[] = []
    for (const a of [...this.since.keys()]) if (!held.has(a)) { this.since.delete(a); this.last.delete(a) }
    for (const a of held) {
      if (!this.since.has(a)) { this.since.set(a, now); this.last.set(a, now); fired.push(a); continue }
      if (DIRS.includes(a) && now - this.since.get(a)! >= this.delay && now - this.last.get(a)! >= this.every) { this.last.set(a, now); fired.push(a) }
    }
    return fired
  }
}
