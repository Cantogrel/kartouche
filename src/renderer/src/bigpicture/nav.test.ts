import { describe, expect, it } from 'vitest'
import { heldActions, joyconHalvesPressed, padActions, pickNext, Repeater, rightStickScroll, type Box } from './nav'

const box = (x: number, y: number): Box => ({ x, y, w: 100, h: 100 })

describe('pickNext', () => {
  const cur = box(200, 200)
  const others = [box(0, 200), box(400, 200), box(200, 0), box(200, 400), box(420, 60)]
  it('choisit le voisin dans chaque direction', () => {
    expect(pickNext(cur, others, 'left')).toBe(0)
    expect(pickNext(cur, others, 'right')).toBe(1)
    expect(pickNext(cur, others, 'up')).toBe(2)
    expect(pickNext(cur, others, 'down')).toBe(3)
  })
  it('garde la ligne plutôt que la diagonale', () => {
    expect(pickNext(cur, [box(420, 60), box(600, 200)], 'right')).toBe(1)
  })
  it('renvoie -1 sans voisin', () => {
    expect(pickNext(cur, [box(0, 200)], 'right')).toBe(-1)
    expect(pickNext(cur, [], 'up')).toBe(-1)
  })
  // Bug vécu (Accueil, 2026-10-01) : une rangée incomplète (dernière rangée d'une section, ou section suivante après
  // l'en-tête) n'a pas de tuile dans la colonne courante ; il ne faut jamais sauter par-dessus elle pour retomber sur
  // une tuile plus lointaine mais bien alignée en colonne.
  it('ne saute pas une rangée trouée pour une tuile plus loin mais alignée', () => {
    const twoRowsDownAligned = box(200, 500) // même colonne, 2 rangées plus bas (ex. section suivante)
    const nextRowOffColumn = box(0, 350) // rangée immédiatement en dessous, mais décalée
    expect(pickNext(cur, [twoRowsDownAligned, nextRowOffColumn], 'down')).toBe(1)
  })
  it('garde la colonne quand la rangée la plus proche a bien une tuile à cet emplacement', () => {
    const sameColumnNextRow = box(200, 354) // rangée immédiate, même colonne
    const offColumnSameRow = box(420, 354) // même rangée, colonne voisine
    expect(pickNext(cur, [sameColumnNextRow, offColumnSameRow], 'down')).toBe(0)
  })
})

describe('manette', () => {
  const pad = (pressed: number[], axes = [0, 0]) => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })), axes })
  it('lit boutons et stick', () => {
    expect([...heldActions(pad([0, 13]))].sort()).toEqual(['accept', 'down'])
    expect([...heldActions(pad([], [-0.9, 0.2]))]).toEqual(['left'])
    expect(heldActions(pad([], [0.3, 0.3])).size).toBe(0)
  })
  it('inverse A et B et règle le seuil du stick', () => {
    expect([...heldActions(pad([0]), { swapAB: true })]).toEqual(['back'])
    expect([...heldActions(pad([1]), { swapAB: true })]).toEqual(['accept'])
    expect([...heldActions(pad([2]), { swapAB: true })]).toEqual(['x'])
    expect([...heldActions(pad([], [0.4, 0]), { threshold: 0.3 })]).toEqual(['right'])
    expect(heldActions(pad([], [0.4, 0]), { threshold: 0.6 }).size).toBe(0)
  })
  it('stick droit : zone morte respectée, vitesse proportionnelle, sans effet sur le stick gauche', () => {
    const pad = (axes: number[]) => ({ buttons: [], axes })
    expect(rightStickScroll([pad([0, 0, 0, 0])], 0.15, 22)).toBe(0)
    expect(rightStickScroll([pad([0, 0, 0, 0.1])], 0.15, 22)).toBe(0)
    expect(rightStickScroll([pad([0, 0, 0, 0.5])], 0.15, 22)).toBeCloseTo(11)
    expect(rightStickScroll([pad([0, 0, 0, -0.5])], 0.15, 22)).toBeCloseTo(-11)
    // Stick gauche (axes 0/1) dévié n'a aucun effet : seul l'axe 3 (stick droit vertical) compte.
    expect(rightStickScroll([pad([0.9, 0.9, 0, 0])], 0.15, 22)).toBe(0)
    // Aucune manette / manette débranchée (null) : pas d'erreur, 0.
    expect(rightStickScroll([null], 0.15, 22)).toBe(0)
    expect(rightStickScroll([], 0.15, 22)).toBe(0)
  })
  it('déclenche une fois, puis répète les directions seulement', () => {
    const r = new Repeater(400, 100)
    expect(r.update(new Set(['right', 'accept']), 0)).toEqual(['right', 'accept'])
    expect(r.update(new Set(['right', 'accept']), 300)).toEqual([])
    expect(r.update(new Set(['right', 'accept']), 400)).toEqual(['right'])
    expect(r.update(new Set(['right', 'accept']), 450)).toEqual([])
    expect(r.update(new Set(['right', 'accept']), 500)).toEqual(['right'])
    expect(r.update(new Set(), 520)).toEqual([])
    expect(r.update(new Set(['accept']), 530)).toEqual(['accept'])
  })
})

describe('manettes Nintendo', () => {
  const mk = (id: string, pressed: number[], axes = [0, 0, 0, 0]) => ({ id, buttons: Array.from({ length: 22 }, (_, i) => ({ pressed: pressed.includes(i) })), axes })
  const pro = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'
  const xbox = 'Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)'
  const pair = 'Joy-Con L+R (STANDARD GAMEPAD Vendor: 057e Product: 200e)'

  it('A et B sont échangés automatiquement sur une manette Nintendo, pas sur une Xbox', () => {
    expect([...padActions(mk(pro, [1]))]).toEqual(['accept'])
    expect([...padActions(mk(pro, [0]))]).toEqual(['back'])
    expect([...padActions(mk(xbox, [0]))]).toEqual(['accept'])
  })

  it('Joy-Con assemblés : une seule manette standard, A et B échangés', () => {
    expect([...padActions(mk(pair, [1]), { split: false })]).toEqual(['accept'])
  })

  it('Joy-Con séparés : chaque moitié est un Joy-Con seul tenu à l’horizontale', () => {
    // Gauche : flèche du bas (13) = valider, stick vers le haut (axe 0 positif) = haut, SL (18) = précédent.
    expect([...padActions(mk(pair, [13, 18], [0.9, 0, 0, 0]), { split: true })].sort()).toEqual(['accept', 'prev', 'up'])
    // Droit : bouton X (3) = valider (le X gravé est à la place du A à l'horizontale), stick vers la droite (axe 3 négatif) = droite.
    expect([...padActions(mk(pair, [3], [0, 0, 0, -0.9]), { split: true })].sort()).toEqual(['accept', 'right'])
    // SL est à gauche sur le Joy-Con gauche, mais SR l'est sur le droit ; L/ZL (gauche) et R/ZR (droit) remplacent LT/RT.
    expect([...padActions(mk(pair, [20]), { split: true })]).toEqual(['prev'])
    expect([...padActions(mk(pair, [4, 6]), { split: true })].sort()).toEqual(['nextFilter', 'prevFilter'])
    expect([...padActions(mk(pair, [5, 7]), { split: true })].sort()).toEqual(['nextFilter', 'prevFilter'])
    expect([...padActions(mk(pair, [1]), { split: true })]).toEqual(['back'])
  })

  it('test des boutons : une entrée par Joy-Con, avec les noms gravés', () => {
    expect(joyconHalvesPressed(mk(pair, [4, 17, 1, 9]))).toEqual([
      { title: 'Joy-Con (L)', pressed: ['L', 'Capture'] },
      { title: 'Joy-Con (R)', pressed: ['A', '+'] }
    ])
  })
})
