import { describe, expect, it } from 'vitest'
import { orderConsolesByRecency, type LibraryEntry } from './library'

let nextId = 1
const entry = (console: string, lastPlayed: number | null): LibraryEntry => ({
  id: nextId++, gameId: null, console, title: console, path: '', size: 0, match: 'none',
  missing: false, addedAt: 0, playMinutes: 0, lastPlayed, favorite: false, pinned: false, collections: []
})

describe('orderConsolesByRecency', () => {
  it('met en tête la console du jeu le plus récemment lancé', () => {
    const entries = [entry('nes', 100), entry('switch', 300), entry('ps1', 200)]
    expect(orderConsolesByRecency(entries)).toEqual(['switch', 'ps1', 'nes'])
  })
  it("classe une console par son lancement le plus récent, pas le dernier jeu ajouté à cette console", () => {
    const entries = [entry('nes', 100), entry('nes', 500), entry('switch', 300)]
    expect(orderConsolesByRecency(entries)).toEqual(['nes', 'switch'])
  })
  it("replie les consoles sans historique sur l'ordre du catalogue (Nintendo puis Sony, chronologique)", () => {
    const entries = [entry('ps1', null), entry('nes', null), entry('switch', null)]
    expect(orderConsolesByRecency(entries)).toEqual(['nes', 'switch', 'ps1'])
  })
  it('place les consoles avec historique avant celles sans, chacune dans son propre ordre', () => {
    const entries = [entry('ps1', null), entry('switch', 50), entry('nes', null)]
    expect(orderConsolesByRecency(entries)).toEqual(['switch', 'nes', 'ps1'])
  })
})
