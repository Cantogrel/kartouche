import { describe, expect, it } from 'vitest'
import { canonicalGenre, mainGenre } from './genres'

describe('genres', () => {
  it('ramène les noms des différentes sources au même genre', () => {
    expect(canonicalGenre('Role-playing (RPG)')).toBe('rpg')
    expect(canonicalGenre('Role-Playing')).toBe('rpg')
    expect(canonicalGenre("Shoot'em Up")).toBe('shmup')
    expect(canonicalGenre('Hack and slash/Beat \'em up')).toBe('beatemup')
    expect(canonicalGenre('Compilation')).toBeNull()
  })
  it('choisit le genre le plus caractéristique', () => {
    expect(mainGenre(['Adventure', 'Role-playing (RPG)'])).toBe('rpg')
    expect(mainGenre(['Shooter', 'Platform', 'Puzzle', 'Adventure'])).toBe('puzzle')
    expect(mainGenre(['Adventure', 'Indie'])).toBe('adventure')
    expect(mainGenre(['Puzzle', 'Adventure'])).toBe('adventure')
    expect(mainGenre([])).toBeNull()
  })
})
