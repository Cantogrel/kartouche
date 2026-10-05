import { describe, expect, it } from 'vitest'
import { normalizeOverride, resolveView, type BaseView } from './overrides'

const base: BaseView = { title: 'Super Mario World', description: 'Plateforme.', genre: 'Plateforme', year: 1990, developer: 'Nintendo' }

describe('normalizeOverride', () => {
  it('retire les espaces de bord, borne la longueur et traite le vide comme « rétablir »', () => {
    expect(normalizeOverride('title', '  Mon titre  ')).toBe('Mon titre')
    expect(normalizeOverride('title', '   ')).toBeNull()
    expect(normalizeOverride('title', 42)).toBeNull()
    expect(normalizeOverride('title', 'x'.repeat(500))).toHaveLength(200)
    expect(normalizeOverride('description', 'y'.repeat(9000))).toHaveLength(8000)
  })

  it('n’accepte une année que si c’est un entier plausible', () => {
    expect(normalizeOverride('year', ' 1994 ')).toBe('1994')
    for (const bad of ['94', '1949', '2101', 'abcd', '19.9', '']) expect(normalizeOverride('year', bad)).toBeNull()
  })

  it('n’accepte pour une image qu’un chemin relatif sans remontée, en slashs', () => {
    expect(normalizeOverride('cover', '12\\cover.png')).toBe('12/cover.png')
    for (const bad of ['C:\\Windows\\x.png', '/etc/passwd', '\\\\serveur\\p\\x.png', '../x.png', '12/../../x.png', 'a/..', 'a:b.png', 'x'.repeat(300)]) {
      expect(normalizeOverride('cover', bad)).toBeNull()
    }
  })
})

describe('resolveView', () => {
  it('sans surcharge : valeurs d’origine, rien de modifié', () => {
    const v = resolveView(base)
    expect(v).toMatchObject({ ...base, images: {}, overridden: [] })
  })

  it('remplace champ par champ, et liste ce qui est modifié', () => {
    const v = resolveView(base, { title: 'Mon Mario', year: '1991', cover: '3/cover.png' })
    expect(v.title).toBe('Mon Mario')
    expect(v.year).toBe(1991)
    expect(v.genre).toBe('Plateforme')
    expect(v.description).toBe('Plateforme.')
    expect(v.images).toEqual({ cover: '3/cover.png' })
    expect(v.overridden).toEqual(['title', 'year', 'cover'])
  })

  it('ignore une année illisible stockée dans la base', () => {
    expect(resolveView(base, { year: 'n/a' }).year).toBe(1990)
  })
})
