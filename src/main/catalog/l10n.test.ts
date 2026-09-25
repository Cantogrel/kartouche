import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import type { CatalogGame } from '@shared/catalog'
import { chunkText, localizeDetails, machineTranslate, wikipediaSummary } from './l10n'

const game: CatalogGame = { id: 1, console: 'ps3', title: 'The Witcher 3: Wild Hunt', name: 'The Witcher 3: Wild Hunt', region: '', year: null, genre: null, developer: null, crc: null, sha1: null, size: null, popularity: null, img: null }
const wiki = (title: string, extract: string) => async (url: string): Promise<unknown> =>
  url.includes('list=search') ? { query: { search: [{ title }] } } : { query: { pages: { 1: { extract } } } }

describe('Wikipédia', () => {
  it('retient l’article dont le titre correspond au jeu', async () => {
    const text = await wikipediaSummary('The Witcher 3: Wild Hunt', 'fr', wiki('The Witcher 3 : Wild Hunt', 'The Witcher 3 est un jeu vidéo de rôle.'))
    expect(text).toContain('jeu vidéo')
  })
  it('refuse un article au titre différent ou qui n’est pas un jeu', async () => {
    expect(await wikipediaSummary('The Witcher 3: Wild Hunt', 'fr', wiki('Wild Hunt', 'Chasse sauvage, jeu vidéo.'))).toBeNull()
    expect(await wikipediaSummary('The Witcher 3: Wild Hunt', 'fr', wiki('The Witcher 3 : Wild Hunt', 'Page d’homonymie.'))).toBeNull()
  })
})

describe('traduction automatique', () => {
  it('découpe aux fins de phrases', () => {
    const chunks = chunkText('One two three. Four five six. Seven eight nine.', 20)
    expect(chunks.every((c) => c.length <= 20)).toBe(true)
    expect(chunks.join(' ')).toBe('One two three. Four five six. Seven eight nine.')
  })
  it('renvoie null quand le quota est épuisé', async () => {
    expect(await machineTranslate('Hello world.', 'fr', async () => ({ responseStatus: 200, quotaFinished: true, responseData: { translatedText: 'x' } }))).toBeNull()
    expect(await machineTranslate('Hello world.', 'fr', async () => ({ responseStatus: 200, responseData: { translatedText: 'Bonjour le monde.' } }))).toBe('Bonjour le monde.')
  })
})

describe('localizeDetails', () => {
  const setup = (): DatabaseSync => { const db = new DatabaseSync(':memory:'); migrate(db); return db }
  it('laisse l’anglais tel quel', async () => {
    const d = { provider: 'igdb', summary: 'Hello.' }
    expect(await localizeDetails(setup(), game, Promise.resolve(d), 'en')).toBe(d)
  })
  it('préfère Wikipédia et met en cache', async () => {
    const db = setup()
    let calls = 0
    const get = async (url: string): Promise<unknown> => { calls++; return wiki('The Witcher 3 : Wild Hunt', 'Un jeu vidéo.')(url) }
    const d = await localizeDetails(db, game, Promise.resolve({ provider: 'igdb', summary: 'English.' }), 'fr', { get })
    expect(d).toMatchObject({ summary: 'Un jeu vidéo.', summarySource: 'wikipedia', summaryLang: 'fr' })
    const n = calls
    await localizeDetails(db, game, Promise.resolve({ provider: 'igdb', summary: 'English.' }), 'fr', { get })
    expect(calls).toBe(n)
  })
  it('se rabat sur la traduction automatique, sinon garde l’anglais', async () => {
    const db = setup()
    const get = async (url: string): Promise<unknown> => url.includes('mymemory') ? { responseStatus: 200, responseData: { translatedText: 'Traduit.' } } : { query: { search: [] } }
    expect(await localizeDetails(db, game, Promise.resolve({ provider: 'igdb', summary: 'English.' }), 'fr', { get })).toMatchObject({ summary: 'Traduit.', summarySource: 'machine' })
    const db2 = setup()
    const fail = async (): Promise<unknown> => null
    expect((await localizeDetails(db2, { ...game, id: 2 }, Promise.resolve({ provider: 'igdb', summary: 'English.' }), 'fr', { get: fail }))?.summary).toBe('English.')
  })
})
