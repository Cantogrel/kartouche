import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import type { CatalogGame } from '@shared/catalog'
import { capAtSentence, chooseSummary, chunkText, localizeDetails, machineTranslate, wikipediaSummary } from './l10n'

const game: CatalogGame = { id: 1, console: 'ps3', title: 'The Witcher 3: Wild Hunt', name: 'The Witcher 3: Wild Hunt', region: '', year: null, genre: null, developer: null, crc: null, sha1: null, size: null, popularity: null, img: null }
const wiki = (title: string, extract: string) => async (url: string): Promise<unknown> =>
  url.includes('list=search') ? { query: { search: [{ title }] } } : { query: { pages: { 1: { extract } } } }

describe('Wikipédia', () => {
  it('retient l’article dont le titre correspond au jeu', async () => {
    const text = await wikipediaSummary('The Witcher 3: Wild Hunt', 'fr', wiki('The Witcher 3 : Wild Hunt', 'The Witcher 3 est un jeu vidéo de rôle.'))
    expect(text).toContain('jeu vidéo')
  })
  it('préfère l’article principal à sa variante entre parenthèses et accepte « jeu d’action-aventure »', async () => {
    const get = async (url: string): Promise<unknown> => url.includes('list=search')
      ? { query: { search: [{ title: 'The Wind Waker (jeu vidéo, 2026)' }, { title: 'The Wind Waker' }] } }
      : { query: { pages: { 1: { extract: url.includes(encodeURIComponent('The Wind Waker (jeu')) ? 'Remake, jeu vidéo.' : 'The Wind Waker est un jeu d’action-aventure.' } } } }
    expect(await wikipediaSummary('The Wind Waker', 'fr', get)).toBe('The Wind Waker est un jeu d’action-aventure.')
  })
  it('accepte un titre d’article plus court que celui des DAT (Pokémon Jaune), jamais un fragment ni un autre jeu', async () => {
    const name = 'Pokemon - Version Jaune - Edition Speciale Pikachu'
    expect(await wikipediaSummary(name, 'fr', wiki('Pokémon Jaune', 'Pokémon Jaune est un jeu vidéo de rôle.'))).toContain('jeu vidéo')
    expect(await wikipediaSummary(name, 'fr', wiki('Pokémon Rouge et Bleu', 'Pokémon Rouge et Bleu sont des jeux vidéo.'))).toBeNull()
  })
  it('refuse un article au titre différent ou qui n’est pas un jeu', async () => {
    expect(await wikipediaSummary('The Witcher 3: Wild Hunt', 'fr', wiki('Wild Hunt', 'Chasse sauvage, jeu vidéo.'))).toBeNull()
    expect(await wikipediaSummary('The Witcher 3: Wild Hunt', 'fr', wiki('The Witcher 3 : Wild Hunt', 'Page d’homonymie.'))).toBeNull()
  })
})

describe('choix et longueur de la description', () => {
  it('capAtSentence coupe à une fin de phrase, jamais au milieu d’un mot', () => {
    const text = 'Première phrase. Deuxième phrase. Troisième phrase très longue qui dépasse largement.'
    expect(capAtSentence(text, 40)).toBe('Première phrase. Deuxième phrase.')
    expect(capAtSentence('court.', 40)).toBe('court.')
    expect(capAtSentence('x'.repeat(100), 40)).toBe('x'.repeat(40) + '…')
  })
  it('chooseSummary suit les règles par langue', () => {
    const longText = 'a'.repeat(900)
    expect(chooseSummary(null, undefined, 'fr')).toBe('provider')
    expect(chooseSummary(null, 'texte', 'fr')).toBe('translate')
    expect(chooseSummary(null, 'text', 'en')).toBe('provider')
    expect(chooseSummary('wiki', undefined, 'fr')).toBe('wiki')
    expect(chooseSummary('a'.repeat(600), 'b'.repeat(480), 'en')).toBe('wiki')
    expect(chooseSummary('a'.repeat(300), 'b'.repeat(480), 'en')).toBe('provider')
    expect(chooseSummary('a'.repeat(100), longText, 'fr')).toBe('translate')
    expect(chooseSummary('a'.repeat(400), longText, 'fr')).toBe('wiki')
  })
  it('l’intro Wikipédia est demandée en 10 phrases et les gardes-fous valent pour les langues à venir', async () => {
    const urls: string[] = []
    const get = async (url: string): Promise<unknown> => { urls.push(url); return wiki('Zelda', 'Zelda es un videojuego de aventuras.')(url) }
    expect(await wikipediaSummary('Zelda', 'es', get)).toBe('Zelda es un videojuego de aventuras.')
    expect(urls.some((u) => u.includes('exsentences=10'))).toBe(true)
    expect(urls[0]).toContain(encodeURIComponent('Zelda videojuego'))
    expect(await wikipediaSummary('Zelda', 'de', wiki('Zelda', 'Zelda bezeichnet mehrere Dinge, auch ein Videospiel.'))).toBeNull()
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
  it('laisse l’anglais du fournisseur quand Wikipédia n’est pas nettement plus complet', async () => {
    const d = { provider: 'igdb', summary: 'Hello, a fairly long provider summary of the game.' }
    const get = async (url: string): Promise<unknown> => wiki('The Witcher 3: Wild Hunt', 'Short video game.')(url)
    expect(await localizeDetails(setup(), game, Promise.resolve(d), 'en', { get })).toBe(d)
    expect(await localizeDetails(setup(), { ...game, id: 2 }, Promise.resolve(d), 'en', { get: async () => null })).toBe(d)
  })
  it('en anglais, prend Wikipédia quand il est nettement plus complet', async () => {
    const long = 'The Witcher 3 is a 2015 action role-playing video game. '.repeat(8).trim()
    const get = async (url: string): Promise<unknown> => wiki('The Witcher 3: Wild Hunt', long)(url)
    const d = await localizeDetails(setup(), game, Promise.resolve({ provider: 'igdb', summary: 'A short blurb.' }), 'en', { get })
    expect(d).toMatchObject({ summary: long, summarySource: 'wikipedia', summaryLang: 'en' })
  })
  it('dans une autre langue, un article Wikipédia très court cède la place à la traduction d’un texte fournisseur bien plus long', async () => {
    const providerText = 'The Witcher 3 is a long and detailed description. '.repeat(8).trim()
    const get = async (url: string): Promise<unknown> => url.includes('mymemory') ? { responseStatus: 200, responseData: { translatedText: 'Traduction longue.' } } : wiki('The Witcher 3 : Wild Hunt', 'Un jeu vidéo.')(url)
    expect(await localizeDetails(setup(), game, Promise.resolve({ provider: 'igdb', summary: providerText }), 'fr', { get })).toMatchObject({ summary: 'Traduction longue.', summarySource: 'machine' })
    // traduction impossible (quota) : l'article Wikipédia, même court, reste le repli
    const noQuota = async (url: string): Promise<unknown> => url.includes('mymemory') ? null : wiki('The Witcher 3 : Wild Hunt', 'Un jeu vidéo.')(url)
    expect(await localizeDetails(setup(), { ...game, id: 3 }, Promise.resolve({ provider: 'igdb', summary: providerText }), 'fr', { get: noQuota })).toMatchObject({ summary: 'Un jeu vidéo.', summarySource: 'wikipedia' })
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
