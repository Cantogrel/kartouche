import { describe, expect, it } from 'vitest'
import { heldActions, pickNext, Repeater, rightStickScroll, type Box } from './nav'

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
