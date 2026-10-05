import { describe, expect, it } from 'vitest'
import { EMBED_REFERER, needsEmbedReferer } from './embedHeaders'

describe('needsEmbedReferer', () => {
  it('ne vaut que pour le cadre du lecteur intégré', () => {
    expect(needsEmbedReferer('https://www.youtube-nocookie.com/embed/abcDEF12345?rel=0', 'subFrame')).toBe(true)
    expect(needsEmbedReferer('https://www.youtube-nocookie.com/embed/abcDEF12345', 'script')).toBe(false)
    expect(needsEmbedReferer('https://www.youtube-nocookie.com/api/stats', 'subFrame')).toBe(false)
    expect(needsEmbedReferer('https://www.youtube.com/embed/abcDEF12345', 'subFrame')).toBe(false)
    expect(needsEmbedReferer('http://www.youtube-nocookie.com/embed/abcDEF12345', 'subFrame')).toBe(false)
    expect(needsEmbedReferer('https://www.youtube-nocookie.com.evil.example/embed/x', 'subFrame')).toBe(false)
    expect(needsEmbedReferer('pas une adresse', 'subFrame')).toBe(false)
  })
  it('le Referer identifie l’application', () => {
    expect(EMBED_REFERER).toBe('https://github.com/Cantogrel/kartouche')
  })
})
