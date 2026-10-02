import { describe, expect, it } from 'vitest'
import { parseExpandedAssets, parseReleasesAtom } from './source'

describe('parseReleasesAtom / parseExpandedAssets', () => {
  it('lit tag et date quel que soit l\'ordre des balises', () => {
    const xml = '<feed><entry><updated>2026-10-02T11:36:34Z</updated><link rel="alternate" href="https://github.com/a/b/releases/tag/v1.2"/></entry><entry><link href="https://github.com/a/b/releases/tag/v1.1"/><updated>2026-09-01T00:00:00Z</updated></entry></feed>'
    expect(parseReleasesAtom(xml)).toEqual([{ tag: 'v1.2', date: '2026-10-02T11:36:34Z' }, { tag: 'v1.1', date: '2026-09-01T00:00:00Z' }])
  })
  it('extrait les fichiers d\'une release', () => {
    const html = '<a href="/a/b/releases/download/v1.2/x-win.zip">x</a><a href="/a/b/archive/refs/tags/v1.2.zip">src</a>'
    expect(parseExpandedAssets(html, 'a/b', 'v1.2')).toEqual([['x-win.zip', 'https://github.com/a/b/releases/download/v1.2/x-win.zip']])
  })
})
