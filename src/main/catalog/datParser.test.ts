import { describe, expect, it } from 'vitest'
import { isVariant, metaByTitle, parseDat } from './datParser'

const DAT = `clrmamepro (
\tname "X"
)

game (
\tname "Super Mario World (USA)"
\tregion "USA"
\trom ( name "Super Mario World (USA).sfc" size 524288 crc B19ED489 sha1 6B47BB75D16514B6A476AA0C73A683A2A4C18765 )
)
game (
\tcomment "Super Mario World (USA)"
\tgenre "Platform"
\trom ( crc B19ED489 )
)
`

describe('parseDat', () => {
  it('lit nom, région et hashes', () => {
    const [g] = parseDat(DAT)
    expect(g.name).toBe('Super Mario World (USA)')
    expect(g.region).toBe('USA')
    expect(g.rom).toMatchObject({ name: 'Super Mario World (USA).sfc', size: '524288', crc: 'B19ED489' })
  })
  it('indexe les métadonnées par titre', () => {
    expect(metaByTitle(parseDat(DAT), 'genre').get('Super Mario World (USA)')).toBe('Platform')
  })
  it('détecte les variantes', () => {
    expect(isVariant('Game (USA) (Beta)')).toBe(true)
    expect(isVariant('Game (USA) (Rev 1)')).toBe(false)
  })
})
