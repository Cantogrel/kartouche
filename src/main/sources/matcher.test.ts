import { beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { replaceConsole } from '../catalog/catalogStore'
import { CatalogMatcher, alternatives, cleanTitle, stripPath } from './matcher'
import { rematchSources } from './import'

const row = (title: string, region: string, extra: { crc?: string; sha1?: string; size?: number } = {}) =>
  ({ title, region, year: null, genre: null, developer: null, crc: extra.crc ?? null, sha1: extra.sha1 ?? null, size: extra.size ?? null, variant: false })

let db: DatabaseSync
const idOf = (console: string, title: string): number => (db.prepare('SELECT id FROM catalog_games WHERE console = ? AND title = ?').get(console, title) as { id: number }).id
const repOf = (console: string, base: string): number => (db.prepare('SELECT id FROM catalog_games WHERE console = ? AND base = ? AND dup = 0').get(console, base) as { id: number }).id

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  replaceConsole(db, 'nes', [row("Gargoyle's Quest II (Europe)", 'Europe'), row('Tetris (Europe)', 'Europe'), row('Tetris 2 (Europe)', 'Europe')], null)
  replaceConsole(db, 'gba', [row('Castlevania - Harmony of Dissonance (Europe)', 'Europe'), row('Castlevania - Harmony of Dissonance (USA)', 'USA')], null)
  replaceConsole(db, 'ps2', [row('CSI - Crime Scene Investigation - 3 Dimensions of Murder (USA)', 'USA'), row('CSI - Crime Scene Investigation (Europe)', 'Europe'),
    row('Silent Hill 4 - The Room (Europe)', 'Europe'), row('Ratchet & Clank - Going Commando (Europe)', 'Europe')], null)
  replaceConsole(db, 'wii', [row('Tierliebe - Gross Geschrieben (Europe) (De,It)', 'Europe')], null)
  replaceConsole(db, 'wiiu', [
    row('Wii U Panorama View - Birds in Flight (Europe)', 'Europe', { crc: 'ABCD1234', sha1: 'AA'.repeat(20), size: 100 }),
    row('Legend of Zelda, The - Breath of the Wild (Europe)', 'Europe'), row('Legend of Zelda, The - Twilight Princess HD (Europe)', 'Europe'),
    row('Legend of Zelda, The - Wind Waker HD (Europe)', 'Europe')], null)
  replaceConsole(db, 'switch', [row('Mario + Rabbids Kingdom Battle', 'World'), row('Castlevania Advance Collection', 'World')], null)
})

describe('nettoyage du titre', () => {
  it('ne garde que le dernier segment du chemin, sans numéro d ordre', () => {
    expect(stripPath("NES/Yoshi's Cookie (Europe)")).toBe("Yoshi's Cookie (Europe)")
    expect(stripPath('Pokémon/Main Series/Core/13.Pokémon Black (USA)')).toBe('Pokémon Black (USA)')
  })
  it('un / dans une étiquette n est pas un séparateur de dossier', () => {
    expect(cleanTitle('Dragon Age: Inquisition [EUR/RUS]')).toBe('Dragon Age: Inquisition')
    expect(cleanTitle('[PS-PS3] Parasite Eve II [EUR/RUS] [ZeroLabs]')).toBe('Parasite Eve II')
  })
  it('un titre alternatif « A / B » ou « A ~ B » donne chaque moitié', () => {
    expect(alternatives('inFamous 2 / Дурная репутация 2 [EUR/RUS]')).toContain('inFamous 2')
    expect(alternatives('Tierliebe - Gross Geschrieben ~ Veterinario (Europe)')).toContain('Tierliebe - Gross Geschrieben')
  })
})

describe('CatalogMatcher', () => {
  it('rapproche un titre préfixé par son dossier, sur la représentative de la version', () => {
    const m = new CatalogMatcher(db)
    expect(m.match({ console: 'gba', title: 'GBA/Castlevania - Harmony of Dissonance (Europe)' })).toEqual({ gameId: repOf('gba', 'castlevaniaharmonyofdissonance'), kind: 'title' })
  })
  it('rapproche d abord par empreinte (SHA1, ou CRC32 + taille), même avec un titre sans rapport', () => {
    const m = new CatalogMatcher(db)
    const bird = idOf('wiiu', 'Wii U Panorama View - Birds in Flight (Europe)')
    expect(m.match({ console: 'wiiu', title: 'Xyz', sha1: 'aa'.repeat(20) })).toEqual({ gameId: bird, kind: 'hash' })
    expect(m.match({ console: 'wiiu', title: 'Xyz', crc: 'abcd1234', sizeBytes: 100 })).toEqual({ gameId: bird, kind: 'hash' })
    expect(m.match({ console: 'wiiu', title: 'Xyz', crc: 'abcd1234', sizeBytes: 999 })).toBeNull()
    expect(m.match({ console: 'wiiu', title: 'Xyz', crc: 'abcd1234' })).toBeNull()
  })
  it('l empreinte d une autre console ne rapproche rien', () => {
    expect(new CatalogMatcher(db).match({ console: 'nes', title: 'Xyz', sha1: 'aa'.repeat(20) })).toBeNull()
  })
  it('chiffre romain / arabe, « plus » = « + », double titre ~', () => {
    const m = new CatalogMatcher(db)
    expect(m.match({ console: 'nes', title: "Gargoyle's Quest 2 (USA)" })?.gameId).toBe(idOf('nes', "Gargoyle's Quest II (Europe)"))
    expect(m.match({ console: 'switch', title: 'Mario plus Rabbids - Kingdom Battle' })?.gameId).toBe(idOf('switch', 'Mario + Rabbids Kingdom Battle'))
    expect(m.match({ console: 'switch', title: 'Castlevania_Advance_Collection' })?.gameId).toBe(idOf('switch', 'Castlevania Advance Collection'))
    expect(m.match({ console: 'wii', title: 'Tierliebe - Gross Geschrieben ~ Veterinario - Cuccioli in Pericolo (Europe)' })?.gameId).toBe(idOf('wii', 'Tierliebe - Gross Geschrieben (Europe) (De,It)'))
  })
  it('nom alternatif entre parenthèses', () => {
    expect(new CatalogMatcher(db).match({ console: 'ps2', title: 'Ratchet & Clank 2: Locked and Loaded (Going Commando) [Multi5|PAL]' })?.gameId).toBe(idOf('ps2', 'Ratchet & Clank - Going Commando (Europe)'))
  })
  it('flou : tous les mots de la source dans un titre plus long, sans ambiguïté', () => {
    const m = new CatalogMatcher(db)
    expect(m.match({ console: 'wiiu', title: 'Birds in Flight (EU)' })).toEqual({ gameId: idOf('wiiu', 'Wii U Panorama View - Birds in Flight (Europe)'), kind: 'fuzzy' })
    expect(m.match({ console: 'wiiu', title: 'Breath of the Wild (EU) (v208)' })?.gameId).toBe(idOf('wiiu', 'Legend of Zelda, The - Breath of the Wild (Europe)'))
    expect(m.match({ console: 'ps2', title: 'CSI: 3 Dimensions of Murder [RUS/Multi3|NTSC]' })?.gameId).toBe(idOf('ps2', 'CSI - Crime Scene Investigation - 3 Dimensions of Murder (USA)'))
  })
  it('flou : un titre catalogue plus court que la source (sous-titre ajouté) est accepté', () => {
    expect(new CatalogMatcher(db).match({ console: 'nes', title: "Gargoyle's Quest 2 - The Demon Darkness (U)" })?.gameId).toBe(idOf('nes', "Gargoyle's Quest II (Europe)"))
  })
  it('flou : jamais pour un hack, une démo ou une bêta', () => {
    expect(new CatalogMatcher(db).match({ console: 'nes', title: "Gargoyle's Quest 2 - The Demon Darkness (Hack)" })).toBeNull()
  })
  it('flou : un numéro de suite différent refuse le rapprochement', () => {
    const m = new CatalogMatcher(db)
    expect(m.match({ console: 'wiiu', title: 'Legend of Zelda Breath of the Wild 2 (EU)' })).toBeNull()
    expect(m.match({ console: 'nes', title: 'Tetris 3 (Europe)' })).toBeNull()
  })
  it('flou : refuse quand deux jeux sont aussi plausibles l un que l autre', () => {
    replaceConsole(db, 'gb', [row('Pokemon Red Edition Alpha (USA)', 'USA'), row('Pokemon Red Edition Omega (USA)', 'USA')], null)
    expect(new CatalogMatcher(db).match({ console: 'gb', title: 'Pokemon Red Edition' })).toBeNull()
  })
  it('un seul mot significatif ne suffit pas au flou', () => {
    expect(new CatalogMatcher(db).match({ console: 'wiiu', title: 'Zelda (EU)' })).toBeNull()
  })
})

describe('rematchSources', () => {
  it('corrige les sources déjà importées sans retélécharger la liste', () => {
    db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('l', 'u', 0)").run()
    const ins = db.prepare("INSERT INTO sources (list_id, console, title, uris, matched) VALUES (1, ?, ?, '[]', 0)")
    ins.run('gba', 'GBA/Castlevania - Harmony of Dissonance (Europe)')
    ins.run('gba', 'Inconnu Total')
    expect(rematchSources(db)).toEqual({ total: 2, matched: 1 })
    const rows = db.prepare('SELECT matched, game_id FROM sources ORDER BY id').all() as { matched: number; game_id: number | null }[]
    expect(rows[0]).toMatchObject({ matched: 1 })
    expect(rows[0].game_id).toBe(repOf('gba', 'castlevaniaharmonyofdissonance'))
    expect(rows[1]).toEqual({ matched: 0, game_id: null })
  })
})
