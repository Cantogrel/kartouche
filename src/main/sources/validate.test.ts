import { describe, expect, it } from 'vitest'
import { formatValidationErrors, validateSourceList } from './validate'

const valid = () => ({
  schemaVersion: 1,
  name: 'Ma liste',
  homepage: 'https://example.org',
  generatedAt: '2026-09-30T00:00:00Z',
  entries: [{ title: 'Super Mario World', console: 'snes', uris: ['https://example.org/smw.zip'], sizeBytes: 524288, note: 'dump perso' }]
})

describe('validateSourceList', () => {
  it('accepte un document valide', () => {
    const result = validateSourceList(valid())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.document.entries).toHaveLength(1)
  })

  it('rejette un schemaVersion inconnu', () => {
    const doc = { ...valid(), schemaVersion: 2 }
    const result = validateSourceList(doc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.path === 'schemaVersion')).toBe(true)
  })

  it('rejette une entrée avec une console inconnue, message explicite', () => {
    const doc = valid()
    doc.entries[0].console = 'megadrive'
    const result = validateSourceList(doc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toContainEqual({ path: 'entries[0].console', message: 'console inconnue : "megadrive"' })
  })

  it('rejette une entrée avec uris vide', () => {
    const doc = valid()
    doc.entries[0].uris = []
    const result = validateSourceList(doc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.path === 'entries[0].uris')).toBe(true)
  })

  it('rejette une entrée sans titre', () => {
    const doc = valid()
    // @ts-expect-error test d'un champ manquant
    delete doc.entries[0].title
    const result = validateSourceList(doc)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.path === 'entries[0].title')).toBe(true)
  })

  it("rejette ce qui n'est pas un objet JSON", () => {
    expect(validateSourceList(null).ok).toBe(false)
    expect(validateSourceList('oops').ok).toBe(false)
    expect(validateSourceList([]).ok).toBe(false)
  })

  it('accepte un hash à null (champ optionnel absent exporté comme null en JSON)', () => {
    const doc: Record<string, unknown> = valid()
    doc.entries = [{ ...((doc.entries as Record<string, unknown>[])[0]), hash: { crc32: null, sha1: null } }]
    const result = validateSourceList(doc)
    expect(result.ok).toBe(true)
  })

  it('accepte sizeBytes, note, homepage et generatedAt à null', () => {
    const doc = valid()
    doc.homepage = null as unknown as string
    doc.generatedAt = null as unknown as string
    doc.entries[0] = { ...doc.entries[0], sizeBytes: null as unknown as number, note: null as unknown as string }
    const result = validateSourceList(doc)
    expect(result.ok).toBe(true)
  })
})

describe('formatValidationErrors', () => {
  it('reste courte même avec des milliers d’entrées en erreur', () => {
    const doc = valid()
    doc.entries = Array.from({ length: 5000 }, (_, i) => ({ ...doc.entries[0], title: `Jeu ${i}`, console: 'megadrive' }))
    const result = validateSourceList(doc)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const message = formatValidationErrors(result.errors)
    expect(message.length).toBeLessThan(500)
    expect(message).toContain('5000 entrées')
  })
})
