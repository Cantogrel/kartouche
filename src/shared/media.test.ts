import { describe, expect, it } from 'vitest'
import { defaultBackgroundId, rankTrailersByTitle, trailerTitlePenalty } from './media'

describe('defaultBackgroundId', () => {
  const m = { screenshots: ['s1', 's2'], artworks: ['a1', 'a2'] }
  it('jamais l’image de la bannière quand elle vient d’IGDB (illustration, à défaut capture)', () => {
    expect(defaultBackgroundId(m, true)).toBe('s1')
    expect(defaultBackgroundId({ screenshots: ['s1', 's2'], artworks: [] }, true)).toBe('s2')
    expect(defaultBackgroundId({ screenshots: ['s1'], artworks: [] }, true)).toBeNull()
  })
  it('bannière du catalogue (hors IGDB) : première capture, sinon illustration', () => {
    expect(defaultBackgroundId(m, false)).toBe('s1')
    expect(defaultBackgroundId({ screenshots: [], artworks: ['a1'] }, false)).toBe('a1')
    expect(defaultBackgroundId(null, false)).toBeNull()
  })
})

describe('trailerTitlePenalty / rankTrailersByTitle', () => {
  const game = 'Pokemon - Black Version'
  const trailers = [{ id: 'a', name: 'Trailer' }, { id: 'b', name: 'Trailer' }, { id: 'c', name: 'Trailer' }, { id: 'd', name: 'Trailer' }]
  const titles = ['Pokemon Black and White 2: Animated Trailer (English)', 'Pokemon Black & White (DS) English Trailer', 'Pokémon the Series: Black & White – Episode 1', 'Pokemon Black and White - Japanese Trailer']
  it('écarte série animée et suite, garde la bande-annonce du jeu en tête', () => {
    const ranked = rankTrailersByTitle(trailers, titles, game)
    expect(ranked.map((v) => v.id)).toEqual(['b', 'd', 'a', 'c'])
    expect(ranked[0].name).toBe('Pokemon Black & White (DS) English Trailer')
  })
  it('un titre introuvable garde l’ordre d’IGDB et son nom', () => {
    const ranked = rankTrailersByTitle(trailers, [null, null, null, null], game)
    expect(ranked.map((v) => v.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(ranked[0].name).toBe('Trailer')
  })
  it('un numéro propre au jeu n’est pas une suite', () => {
    expect(trailerTitlePenalty('Pokemon Black 2 trailer', 'Pokemon Black 2')).toBe(0)
    expect(trailerTitlePenalty('Pokemon Black 2 trailer', 'Pokemon Black')).toBeGreaterThan(0)
  })
})
