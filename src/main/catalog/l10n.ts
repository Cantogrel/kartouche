import type { DatabaseSync } from 'node:sqlite'
import type { CatalogGame, GameDetails } from '@shared/catalog'
import { matchKey } from './popularity'

type Json = (url: string) => Promise<unknown | null>
const UA = 'Kartouche/0.1 (game library; https://github.com/)'

const getJson: Json = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
  return res.ok ? res.json() : null
}

const TTL_MS = 90 * 24 * 3600 * 1000
const MISS_TTL_MS = 24 * 3600 * 1000

/** Mot qui désigne un jeu vidéo dans chaque langue : ajouté à la recherche Wikipédia pour tomber sur l'article du jeu plutôt que sur son sujet. */
const GAME_WORD: Record<string, string> = { fr: 'jeu vidéo', en: 'video game', es: 'videojuego', de: 'Videospiel', it: 'videogioco', pt: 'jogo eletrónico', zh: '电子游戏', ja: 'ビデオゲーム' }
/** Garde-fous : le texte parle bien d'un jeu vidéo (dans l'une des langues gérées), et n'est pas une page d'homonymie. */
const IS_GAME = /\bjeu\b|video ?game|videojuego|videospiel|videogioco|\bjogo\b|电子游戏|游戏|ゲーム/i
const IS_DISAMBIGUATION = /peut désigner|may (also )?refer to|homonymie|puede referirse|bezeichnet|può riferirsi|pode referir|可以指/i
/** Longueur maximale d'une description : coupée à la fin d'une phrase, pour ne pas finir au milieu d'un mot. */
export const MAX_SUMMARY = 1800

/** Coupe `text` à la dernière fin de phrase avant `max` caractères (le texte entier s'il est plus court). */
export function capAtSentence(text: string, max = MAX_SUMMARY): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('.\n'))
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd() + '…'
}

const TITLE_STOPWORDS = new Set(['version', 'edition', 'the', 'a', 'an', 'of', 'and', 'et', 'de', 'la', 'le', 'les', 'du', 'des', 'el', 'der', 'die', 'das', 'il'])
const titleWords = (title: string): string[] => title.replace(/\s*[([][^)\]]*[)\]]/g, '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !TITLE_STOPWORDS.has(w))

/**
 * Titre d'article qui désigne le jeu sous un nom plus court que celui des DAT (« Pokémon Jaune » pour « Pokemon - Version Jaune - Edition Speciale
 * Pikachu ») : au moins deux mots, tous présents dans le nom du jeu, dont son premier mot. Un article plus long ou sur la série seule (« Pokémon ») ne passe pas.
 */
export const isShortenedTitle = (articleTitle: string, gameName: string): boolean => {
  const words = titleWords(articleTitle)
  const game = titleWords(gameName)
  return words.length >= 2 && words.every((w) => game.includes(w)) && words.includes(game[0])
}

/** Introduction de l'article Wikipédia consacré au jeu (jusqu'à 10 phrases), dans la langue demandée ; null s'il n'y en a pas de sûr. */
export async function wikipediaSummary(name: string, lang: string, get: Json = getJson): Promise<string | null> {
  const api = `https://${lang}.wikipedia.org/w/api.php`
  const search = await get(`${api}?action=query&list=search&srsearch=${encodeURIComponent(`${name} ${GAME_WORD[lang] ?? GAME_WORD['en']}`)}&srlimit=4&format=json`) as
    { query?: { search?: { title: string }[] } } | null
  const want = matchKey(name)
  // Le titre de l'article doit correspondre au jeu (« The Witcher 3 : Wild Hunt » ≈ « The Witcher 3: Wild Hunt »), pas seulement lui ressembler.
  const found = search?.query?.search ?? []
  const key = (r: { title: string }): string => matchKey(r.title)
  const strong = found.filter((r) => key(r) === want || key(r).startsWith(want))
  // Titre plus court que celui des DAT (« Pokémon Jaune »), avant l'article de la série seule (« Pokémon »), toléré en dernier recours.
  const weak = found.filter((r) => want.startsWith(key(r)) && key(r).length >= 6)
  // L'article principal (« … Ocarina of Time ») passe avant une variante entre parenthèses (« … (jeu vidéo, 2026) »).
  const pick = (hits: { title: string }[]): { title: string } | undefined => hits.find((r) => !/[([]/.test(r.title)) ?? hits[0]
  const hit = pick(strong) ?? found.find((r) => isShortenedTitle(r.title, name)) ?? pick(weak)
  if (!hit) return null
  const page = await get(`${api}?action=query&prop=extracts&exintro=1&explaintext=1&exsentences=10&redirects=1&titles=${encodeURIComponent(hit.title)}&format=json`) as
    { query?: { pages?: Record<string, { extract?: string }> } } | null
  const text = Object.values(page?.query?.pages ?? {})[0]?.extract?.trim()
  // Garde-fou : une page d'homonymie ou un article sans rapport n'est pas une description de jeu vidéo.
  return text && IS_GAME.test(text) && !IS_DISAMBIGUATION.test(text) ? capAtSentence(text) : null
}

/** En deçà, l'article Wikipédia est un résumé trop court pour valoir mieux qu'un texte de fournisseur bien plus long. */
export const SHORT_WIKI = 250

/**
 * Quelle description garder. `wiki` : intro Wikipédia dans la langue demandée ; `provider` : résumé des fournisseurs (IGDB, en anglais).
 *  - anglais : Wikipédia seulement s'il est nettement plus complet (15 % de plus) que le texte du fournisseur ;
 *  - autre langue : l'article Wikipédia (écrit par des humains), sauf s'il est très court devant un texte fournisseur bien plus long : on tente alors la
 *    traduction de ce dernier (le résumé Wikipédia reste le repli) ;
 *  - sans article : traduction du texte du fournisseur (anglais : le texte du fournisseur tel quel).
 */
export function chooseSummary(wiki: string | null, provider: string | undefined, lang: string): 'wiki' | 'provider' | 'translate' {
  if (!wiki) return provider && lang !== 'en' ? 'translate' : 'provider'
  if (!provider) return 'wiki'
  if (lang === 'en') return wiki.length >= provider.length * 1.15 ? 'wiki' : 'provider'
  return wiki.length < SHORT_WIKI && provider.length > wiki.length * 1.5 ? 'translate' : 'wiki'
}

/** Découpe en morceaux de 450 caractères maximum, à la fin d'une phrase (limite de l'API de traduction). */
export function chunkText(text: string, max = 450): string[] {
  const out: string[] = []
  let cur = ''
  for (const sentence of text.replace(/\s*\n+\s*/g, ' ').match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text]) {
    if (cur && (cur + sentence).length > max) { out.push(cur.trim()); cur = '' }
    cur += sentence
  }
  if (cur.trim()) out.push(cur.trim())
  return out.flatMap((c) => (c.length <= max ? [c] : c.match(new RegExp(`.{1,${max}}`, 'g')) ?? [c]))
}

/** Traduction automatique (MyMemory, gratuite, sans clé). null si le quota du jour est épuisé ou en cas d'échec. */
export async function machineTranslate(text: string, lang: string, get: Json = getJson): Promise<string | null> {
  let budget = 1800 // caractères traduits au maximum par fiche : le quota anonyme est de quelques milliers par jour
  const chunks = chunkText(text).filter((c) => (budget -= c.length) + c.length > 0)
  // Les morceaux sont traduits en parallèle : la fiche attend le plus lent, pas la somme.
  const parts = await Promise.all(chunks.map(async (chunk) => {
    const r = await get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${lang}`) as
      { responseStatus?: number | string; quotaFinished?: boolean; responseData?: { translatedText?: string } } | null
    const t = r?.responseData?.translatedText
    return !r || r.quotaFinished || Number(r.responseStatus) !== 200 || !t || /MYMEMORY WARNING/i.test(t) ? null : t
  }))
  return parts.length && parts.every((x): x is string => x !== null) ? parts.join(' ') : null
}

/**
 * Description dans la langue de l'interface : Wikipédia d'abord (rédigée par des humains), sinon traduction automatique du texte
 * source. `base` (fiche des fournisseurs) est attendue EN PARALLÈLE de la recherche Wikipédia. Résultat mis en cache, échec compris (24 h).
 * Sans traduction possible, la fiche reste dans sa langue d'origine ; null si on n'a rien du tout.
 */
export async function localizeDetails(db: DatabaseSync, game: CatalogGame, base: Promise<GameDetails | null>, lang: string,
  io: { get?: Json } = {}): Promise<GameDetails | null> {
  const key = `l10n3-${lang}`
  const row = db.prepare('SELECT json, fetched_at FROM game_meta WHERE game_id = ? AND provider = ?').get(game.id, key) as { json: string; fetched_at: number } | undefined
  let hit: { text: string; source: 'wikipedia' | 'machine' } | null | undefined
  if (row) {
    const cached = JSON.parse(row.json) as typeof hit
    if (Date.now() - row.fetched_at < (cached ? TTL_MS : MISS_TTL_MS)) hit = cached
  }
  // Un échec réseau ou de quota n'est pas retenu : seule une réponse définitive « pas d'article » est mise en cache.
  let failed = false
  const wikiP = hit === undefined ? wikipediaSummary(game.name, lang, io.get).catch(() => { failed = true; return null }) : null
  const details = await base
  if (hit === undefined) {
    const wiki = await wikiP
    const choice = chooseSummary(wiki, details?.summary, lang)
    let text: string | null = null
    let source: 'wikipedia' | 'machine' = 'wikipedia'
    if (choice === 'wiki') text = wiki
    else if (choice === 'translate' && details?.summary) {
      const translated = await machineTranslate(details.summary, lang, io.get).catch(() => null)
      if (translated) { text = translated; source = 'machine' } else if (wiki) text = wiki
      else failed = true // quota ou réseau : pas de verdict définitif, on réessaiera
    }
    hit = text ? { text, source } : null
    if (!failed) db.prepare('INSERT INTO game_meta (game_id, provider, json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(game_id, provider) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
      .run(game.id, key, JSON.stringify(hit), Date.now())
  }
  if (!hit) return details
  return { ...(details ?? { provider: hit.source }), summary: hit.text, summaryLang: lang, summarySource: hit.source }
}
