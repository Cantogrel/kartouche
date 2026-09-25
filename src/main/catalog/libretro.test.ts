import { describe, expect, it } from 'vitest'
import { CONSOLES } from '@shared/consoles'
import { fetchConsoleCatalog, thumbnailName, thumbnailUrl } from './libretro'

const snes = CONSOLES.find((c) => c.id === 'snes')!
const DAT = 'clrmamepro (\n\tversion "2026.08.01"\n)\ngame (\n\tname "Zelda (USA)"\n\tregion "USA"\n\trom ( name "z.sfc" size 10 crc abcd1234 )\n)\ngame (\n\tname "Zelda (Japan) (Beta)"\n\trom ( crc 11 )\n)\n'
const META = (field: string, v: string): string => `game (\n\tcomment "Zelda (USA)"\n\t${field} "${v}"\n\trom ( crc ABCD1234 )\n)\n`

describe('fetchConsoleCatalog', () => {
  it('fusionne DAT et métadonnées', async () => {
    const get = async (url: string): Promise<string | null> =>
      url.includes('/genre/') ? META('genre', 'Adventure') : url.includes('/releaseyear/') ? META('releaseyear', '1991') : url.includes('/developer/') ? null : DAT
    const { rows, version } = await fetchConsoleCatalog(snes, get)
    expect(version).toBe('2026.08.01')
    expect(rows[0]).toMatchObject({ title: 'Zelda (USA)', genre: 'Adventure', year: 1991, developer: null, crc: 'ABCD1234', variant: false })
    expect(rows[1].variant).toBe(true)
  })
  it('échoue si le DAT principal manque', async () => {
    await expect(fetchConsoleCatalog(snes, async () => null)).rejects.toThrow()
  })
})

describe('vignettes', () => {
  it('normalise les caractères interdits', () => {
    expect(thumbnailName('Foo: Bar/Baz?')).toBe('Foo_ Bar_Baz_')
    expect(thumbnailUrl(snes, 'A & B (USA)')).toContain('/Named_Boxarts/A%20_%20B%20(USA).png')
  })
})
