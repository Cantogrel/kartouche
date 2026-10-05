import { describe, expect, it } from 'vitest'
import { sortEntries, SOURCE_LABELS } from './library'
import { GAME_SOURCES } from './launch'

const e = (shownTitle: string, o: Partial<{ lastPlayed: number | null; addedAt: number; playMinutes: number }> = {}) => ({ shownTitle, lastPlayed: null, addedAt: 0, playMinutes: 0, ...o })

describe('SOURCE_LABELS', () => {
  it('chaque source connue a un libellé', () => {
    for (const s of GAME_SOURCES) expect(SOURCE_LABELS[s], s).toBeTruthy()
  })
})

describe('sortEntries', () => {
  const list = [e('b', { lastPlayed: 5, addedAt: 1, playMinutes: 10 }), e('A', { lastPlayed: 9, addedAt: 3, playMinutes: 10 }), e('c', { addedAt: 2, playMinutes: 99 })]
  const names = (s: Parameters<typeof sortEntries>[1]): string[] => sortEntries(list, s).map((x) => x.shownTitle)
  it('par titre sans tenir compte de la casse', () => expect(names('title')).toEqual(['A', 'b', 'c']))
  it('par dernière partie, les jamais joués à la fin', () => expect(names('recent')).toEqual(['A', 'b', 'c']))
  it('par ajout récent', () => expect(names('added')).toEqual(['A', 'c', 'b']))
  it('par temps de jeu, titre en cas d’égalité', () => expect(names('time')).toEqual(['c', 'A', 'b']))
  it('ne modifie pas la liste d’origine', () => { sortEntries(list, 'time'); expect(list.map((x) => x.shownTitle)).toEqual(['b', 'A', 'c']) })
})
