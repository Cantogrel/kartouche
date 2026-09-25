import type { DatabaseSync } from 'node:sqlite'
import type { CatalogGame, GameDetails } from '@shared/catalog'
import { matchKey } from './popularity'

type Json = (url: string) => Promise<unknown | null>
const UA = 'RomVault/0.1 (game library; https://github.com/)'

const getJson: Json = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
  return res.ok ? res.json() : null
}

const TTL_MS = 90 * 24 * 3600 * 1000
const MISS_TTL_MS = 24 * 3600 * 1000

/** Introduction de l'article Wikipédia consacré au jeu, dans la langue demandée ; null s'il n'y en a pas de sûr. */
export async function wikipediaSummary(name: string, lang: string, get: Json = getJson): Promise<string | null> {
  const api = `https://${lang}.wikipedia.org/w/api.php`
  const search = await get(`${api}?action=query&list=search&srsearch=${encodeURIComponent(`${name} jeu vidéo`)}&srlimit=4&format=json`) as
    { query?: { search?: { title: string }[] } } | null
  const want = matchKey(name)
  // Le titre de l'article doit correspondre au jeu (« The Witcher 3 : Wild Hunt » ≈ « The Witcher 3: Wild Hunt »), pas seulement lui ressembler.
  const ok = (r: { title: string }): boolean => { const k = matchKey(r.title); return k === want || k.startsWith(want) || want.startsWith(k) && k.length >= 6 }
  // L'article principal (« … Ocarina of Time ») passe avant une variante entre parenthèses (« … (jeu vidéo, 2026) »).
  const hits = (search?.query?.search ?? []).filter(ok)
  const hit = hits.find((r) => !/[([]/.test(r.title)) ?? hits[0]
  if (!hit) return null
  const page = await get(`${api}?action=query&prop=extracts&exintro=1&explaintext=1&exsentences=5&redirects=1&titles=${encodeURIComponent(hit.title)}&format=json`) as
    { query?: { pages?: Record<string, { extract?: string }> } } | null
  const text = Object.values(page?.query?.pages ?? {})[0]?.extract?.trim()
  // Garde-fou : une page d'homonymie ou un article sans rapport n'est pas une description de jeu vidéo.
  return text && /\bjeu\b|video game/i.test(text) && !/peut désigner|may refer to|homonymie/i.test(text) ? text : null
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
  if (lang === 'en') return base
  const key = `l10n2-${lang}`
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
    const text = wiki ?? (details?.summary ? await machineTranslate(details.summary, lang, io.get).catch(() => null) : null)
    if (!wiki && details?.summary && !text) failed = true
    hit = text ? { text, source: wiki ? 'wikipedia' : 'machine' } : null
    if (!failed) db.prepare('INSERT INTO game_meta (game_id, provider, json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(game_id, provider) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
      .run(game.id, key, JSON.stringify(hit), Date.now())
  }
  if (!hit) return details
  return { ...(details ?? { provider: hit.source }), summary: hit.text, summaryLang: lang, summarySource: hit.source }
}
