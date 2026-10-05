import { describe, expect, it } from 'vitest'
import { defaultBackgroundId } from './media'

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
