import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { queryCatalog, replaceConsole, type CatalogRow } from './catalogStore'
import { PUBLISHER_OTHER } from '@shared/publishers'

const row = (title: string, developer: string | null): CatalogRow =>
  ({ title, region: 'Europe', year: null, genre: null, developer, crc: null, sha1: null, size: null, variant: false })

describe('queryCatalog — filtre éditeur', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  replaceConsole(db, 'nes', [
    row('Zelda', 'Nintendo EAD'),
    row('Kart', 'Nintendo'),
    row('Spyro', 'Insomniac Games'), // reconnu via un studio maison, pas le nom « Sony »
    row('Half-Life', 'Valve Corporation'), // aucun éditeur connu ne le reconnaît (heuristique volontairement courte)
    row('Sans studio', null)
  ], null)

  it('filtre sur un éditeur reconnu via son nom ou un studio maison associé', () => {
    expect(queryCatalog(db, { publishers: ['nintendo'] }).games.map((g) => g.name).sort()).toEqual(['Kart', 'Zelda'])
    expect(queryCatalog(db, { publishers: ['sony'] }).games.map((g) => g.name)).toEqual(['Spyro'])
  })

  it("« other » couvre le développeur non reconnu ET l'absence de développeur", () => {
    const names = queryCatalog(db, { publishers: [PUBLISHER_OTHER] }).games.map((g) => g.name).sort()
    expect(names).toEqual(['Half-Life', 'Sans studio'])
  })

  it('les facettes ignorent leur propre filtre ; un éditeur sans résultat reste listé, à 0 (comme les consoles)', () => {
    const page = queryCatalog(db, { publishers: ['nintendo'] })
    const byId = new Map(page.publishers.map((p) => [p.id, p.count]))
    expect(byId.get('nintendo')).toBe(2)
    expect(byId.get('sony')).toBe(1)
    expect(byId.get(PUBLISHER_OTHER)).toBe(2)
    expect(byId.get('rockstar')).toBe(0) // aucun jeu Rockstar dans ce jeu de données, mais toujours listé
  })
})
