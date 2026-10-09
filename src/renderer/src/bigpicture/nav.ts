/** Navigation par focus (manette / clavier) : choix de l'élément voisin dans une direction et lecture des boutons de la manette. */

export type Dir = 'up' | 'down' | 'left' | 'right'
export type PadAction = Dir | 'accept' | 'back' | 'x' | 'y' | 'prev' | 'next' | 'prevFilter' | 'nextFilter' | 'start'
export interface Box { x: number; y: number; w: number; h: number }

const center = (b: Box): { cx: number; cy: number } => ({ cx: b.x + b.w / 2, cy: b.y + b.h / 2 })

/**
 * Indice du voisin le plus adapté dans la direction demandée, -1 s'il n'y en a pas.
 * Un candidat doit être du bon côté (centre à l'avant du centre courant) ; le score favorise la distance sur l'axe
 * puis pénalise le décalage latéral, ce qui garde le curseur dans sa colonne / sa ligne.
 *
 * Pour haut/bas, on se limite d'abord à la rangée la plus proche (tolérance de 50 % sur sa distance) avant de
 * départager par décalage latéral : sinon, dans une grille à rangées inégales (dernière rangée d'une section
 * incomplète, sections empilées), une tuile bien alignée en colonne mais une rangée plus loin gagnait contre la
 * tuile réellement adjacente quand la rangée immédiate n'a pas de tuile dans cette colonne — on sautait des lignes.
 */
export function pickNext(cur: Box, others: Box[], dir: Dir): number {
  const c = center(cur)
  const candidates = others.map((o, i) => {
    const p = center(o)
    const dx = p.cx - c.cx
    const dy = p.cy - c.cy
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy
    const across = Math.abs(dir === 'left' || dir === 'right' ? dy : dx)
    return { i, along, across }
  }).filter((s) => s.along > 1)
  if (!candidates.length) return -1
  const minAlong = Math.min(...candidates.map((s) => s.along))
  const band = dir === 'up' || dir === 'down' ? candidates.filter((s) => s.along <= minAlong * 1.5) : candidates
  let best = -1
  let bestScore = Infinity
  for (const s of band) {
    const score = s.along + s.across * 3
    if (score < bestScore) { bestScore = score; best = s.i }
  }
  return best
}

export interface PadLike { id?: string; buttons: ArrayLike<{ pressed: boolean }>; axes: ArrayLike<number> }

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

/**
 * Manette de Nintendo (Switch Pro, Joy-Con) : le profil « standard » de Chromium la lit par position (bouton du bas = 0), donc « valider » tombe sur le B de Nintendo.
 * A et B y sont échangés d'office, pour que valider soit le A de la manette.
 */
export const isNintendoPad = (pad: PadLike): boolean => /057e|joy-con|pro controller/i.test(pad.id ?? '')

/** Deux Joy-Con réunis par Chromium en une seule manette (« Joy-Con L+R ») : impossible de les lui faire voir séparés, on lit chaque moitié à part (voir `JOYCON_HALVES`). */
export const isJoyconPair = (pad: PadLike): boolean => /joy-con l\+r/i.test(pad.id ?? '')

/**
 * Une moitié de la manette « Joy-Con L+R », lue comme un Joy-Con seul tenu à l'horizontale (relevé sur de vrais Joy-Con). Le gauche est tourné dans un sens, le droit dans l'autre :
 * `dirs` = [axe, signe] du stick pour chaque direction vue à l'horizontale ; `face` = les quatre boutons par position (est = valider, sud = retour, nord = X, ouest = Y) ;
 * `names` = ce qui est gravé sur chaque bouton (test des boutons).
 */
export interface JoyconHalf {
  dirs: Record<Dir, [number, 1 | -1]>
  face: { accept: number; back: number; x: number; y: number }
  /** Précédent / suivant (SL, SR), puis les filtres (L et ZL du Joy-Con gauche, R et ZR du droit : un Joy-Con seul n'a ni LT ni RT). */
  prev: number; next: number; prevFilter: number; nextFilter: number; start: number
  names: Record<number, string>
  title: string
}

export const JOYCON_HALVES: { left: JoyconHalf; right: JoyconHalf } = {
  left: {
    dirs: { up: [0, 1], down: [0, -1], left: [1, -1], right: [1, 1] },
    face: { accept: 13, back: 14, x: 15, y: 12 },
    prev: 18, next: 19, prevFilter: 4, nextFilter: 6, start: 8,
    names: { 4: 'L', 6: 'ZL', 8: '−', 10: 'L3', 12: '↑', 13: '↓', 14: '←', 15: '→', 17: 'Capture', 18: 'SL', 19: 'SR' },
    title: 'Joy-Con (L)'
  },
  right: {
    dirs: { up: [2, -1], down: [2, 1], left: [3, 1], right: [3, -1] },
    face: { accept: 3, back: 1, x: 2, y: 0 },
    prev: 20, next: 21, prevFilter: 5, nextFilter: 7, start: 9,
    names: { 0: 'B', 1: 'A', 2: 'Y', 3: 'X', 5: 'R', 7: 'ZR', 9: '+', 11: 'R3', 16: 'Home', 20: 'SL', 21: 'SR' },
    title: 'Joy-Con (R)'
  }
}

/** Actions maintenues sur une moitié de « Joy-Con L+R » lue comme un Joy-Con seul. */
export function heldActionsHalf(pad: PadLike, half: JoyconHalf, threshold = STICK): Set<PadAction> {
  const out = new Set<PadAction>()
  for (const d of ['up', 'down', 'left', 'right'] as const) {
    const [axis, sign] = half.dirs[d]
    if ((pad.axes[axis] ?? 0) * sign > threshold) out.add(d)
  }
  const on = (i: number): boolean => !!pad.buttons[i]?.pressed
  if (on(half.face.accept)) out.add('accept')
  if (on(half.face.back)) out.add('back')
  if (on(half.face.x)) out.add('x')
  if (on(half.face.y)) out.add('y')
  if (on(half.prev)) out.add('prev')
  if (on(half.next)) out.add('next')
  if (on(half.prevFilter)) out.add('prevFilter')
  if (on(half.nextFilter)) out.add('nextFilter')
  if (on(half.start)) out.add('start')
  return out
}

/**
 * Actions maintenues par une manette : un « Joy-Con L+R » que l'utilisateur a séparé se lit moitié par moitié (chaque Joy-Con est une manette à part entière),
 * toute autre manette Nintendo avec A et B échangés, les autres telles quelles.
 */
export function padActions(pad: PadLike, opts: { split?: boolean; threshold?: number } = {}): Set<PadAction> {
  if (opts.split && isJoyconPair(pad)) {
    return new Set([...heldActionsHalf(pad, JOYCON_HALVES.left, opts.threshold), ...heldActionsHalf(pad, JOYCON_HALVES.right, opts.threshold)])
  }
  return heldActions(pad, { swapAB: isNintendoPad(pad), threshold: opts.threshold })
}

/** Boutons actuellement enfoncés de chaque moitié d'un « Joy-Con L+R » séparé, par leur nom gravé (test des boutons) ; `n` : numéro de la paire quand il y en a plusieurs. */
export function joyconHalvesPressed(pad: PadLike, n?: number): { title: string; pressed: string[] }[] {
  return [JOYCON_HALVES.left, JOYCON_HALVES.right].map((h) => ({
    title: n === undefined ? h.title : `${h.title} · ${n}`,
    pressed: Object.entries(h.names).flatMap(([i, name]) => (pad.buttons[Number(i)]?.pressed ? [name] : []))
  }))
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
