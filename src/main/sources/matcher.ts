import type { DatabaseSync } from 'node:sqlite'

export interface MatchInput { console: string; title: string; sizeBytes?: number | null; crc?: string | null; sha1?: string | null }
export type SourceMatchKind = 'hash' | 'title' | 'fuzzy'
export interface SourceMatch { gameId: number; kind: SourceMatchKind }

interface Row { id: number; title: string; name: string | null; base: string | null; dup: number; crc: string | null; sha1: string | null; size: number | null }

const EXT = /\.(zip|7z|rar|gz|iso|bin|cue|chd|rvz|wbfs|gcz|nds|3ds|cia|gba|gbc|gb|nes|sfc|smc|n64|z64|v64|nsp|xci|wua|wud|wux|pkg|vpk|psp|cso)$/i
const DIGITS: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' }
// Mots qui ne distinguent pas un jeu d'un autre : retirés du rapprochement flou.
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'to', 'for', 'edition', 'version'])
// Bruit de nommage des collections de scène/archive, hors parenthèses : « v1.01 », « Repack », « PKG »…
const NOISE = /\b(v\d+(\.\d+)*|repack|pkg|iso|ntsc|pal|decrypted|trimmed|reencrypted|update|dlcs?|nodrm|multi\d*)\b/gi

const deaccent = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Dernier segment d'un chemin (« Pokémon/Main Series/Core/13.Pokémon Black (USA) »), sans numéro d'ordre ni extension. */
export function stripPath(title: string): string {
  // Un « / » entre crochets ou parenthèses (« [EUR/RUS] », « (USA/Europe) ») est une étiquette, pas un séparateur de dossier.
  const guarded = title.replace(/\[[^\]]*\]|\([^)]*\)/g, (m) => m.replace(/[\\/]/g, '\u0001'))
  // « A / B » (titre alternatif, souvent en cyrillique) n'est pas un chemin : un séparateur de dossier est collé aux deux noms.
  const seg = guarded.split(/(?<!\s)[\\/](?!\s)/).map((x) => x.trim()).filter(Boolean)
  const last = (seg.length ? seg[seg.length - 1] : guarded).replace(/\u0001/g, '/')
  return last.replace(/^\d+\s*[.)-]\s*/, '').replace(EXT, '').replace(/_apfix(\.\w+)?$/i, '').trim()
}

/** « Legend of Zelda, The: Link » → « The Legend of Zelda: Link ». */
const moveArticle = (s: string): string => s.replace(/^(.*?),\s*(the|a|an)\b(.*)$/i, '$2 $1$3')

/** Titre sans étiquettes entre () et [], préfixes de plateforme, ni bruit de nommage. */
export function cleanTitle(title: string): string {
  let s = stripPath(title).replace(/_/g, ' ')
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/^\s*~[^~]*~\s*/, ' ')
  s = s.replace(NOISE, ' ')
  s = moveArticle(s.replace(/\s+/g, ' ').trim())
  return s.replace(/\s+/g, ' ').trim()
}

// Parenthèse qui est une étiquette (région, langues, révision, support…) et non un titre alternatif.
const TAG = /^(usa|europe|japan|world|asia|korea|china|taiwan|australia|brazil|canada|france|germany|spain|italy|netherlands|sweden|russia|scandinavia|uk|[a-z]{2}(,[a-z]{2})*)\b|\b(rev|beta|demo|proto|sample|unl|hack|kiosk|virtual console|switch online|disc|psn|minis|aftermarket|translation|cd|dvd|folder|multi\d*|v\d)\b/i
const RISKY = /\b(hack|mod|proto|beta|demo|sample|translation|patch|romhack|homebrew|aftermarket|unl)\b/i

/**
 * Titres équivalents d'une même entrée : le titre lui-même, chaque moitié d'un double titre « A ~ B » (éditions régionales),
 * et un nom alternatif entre parenthèses (« Ratchet & Clank 2 (Going Commando) »).
 */
export function alternatives(title: string): string[] {
  const full = stripPath(title)
  const out = [title]
  for (const part of full.split(/\s+[~/]\s+/)) if (part !== full) out.push(part)
  for (const m of full.matchAll(/\(([^()]{5,})\)/g)) {
    const inner = m[1].trim()
    if (inner.split(/\s+/).length >= 2 && !TAG.test(inner)) out.push(inner)
  }
  return out
}

const alnum = (s: string): string => deaccent(s).replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '')

/**
 * Clés de comparaison exactes d'un titre, de la plus fiable à la plus permissive : titre nettoyé tel quel, puis variantes
 * (« plus » = « + » = « & », suffixe « + DLC … » retiré, sans article initial, chiffres romains en chiffres arabes).
 */
export function titleKeys(title: string): { strict: string[]; loose: string[] } {
  const base = cleanTitle(title)
  const strict: string[] = []
  const loose: string[] = []
  const add = (s: string, into: string[] = loose): void => { const k = alnum(s); if (k && !strict.includes(k) && !loose.includes(k)) into.push(k) }
  add(base, strict)
  const noArticle = base.replace(/^(the|a|an)\s+/i, '')
  add(noArticle, strict)
  add(noArticle.replace(/\s+(plus|\+)\s+/gi, ' and '))
  add(noArticle.replace(/\s*(\+|\bplus\b|,)?\s*\bdlcs?\b.*$/i, '').replace(/\s*\+\s*$/, ''))
  add(noArticle.split(/\s+/).map((w) => DIGITS[w.toLowerCase()] ?? w).join(' '))
  return { strict, loose }
}

/** Mots significatifs (sans mots vides, chiffres romains convertis) pour le rapprochement flou. */
export function tokens(title: string): string[] {
  const words = deaccent(cleanTitle(title)).replace(/&/g, ' and ').replace(/\+/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  return words.map((w) => (w.length <= 4 ? DIGITS[w] ?? w : w)).filter((w) => !STOP.has(w))
}

interface Group { rep: number; tokens: Set<string>; digits: string }

interface ConsoleIndex {
  exact: Map<string, number>
  loose: Map<string, number>
  crc: Map<string, { rep: number; size: number | null }[]>
  sha1: Map<string, number[]>
  groups: Group[]
  byToken: Map<string, number[]>
}

const digitSig = (toks: Iterable<string>): string => [...toks].filter((t) => /\d/.test(t)).sort().join(',')

/**
 * Rapprochement des entrées d'une liste de sources avec le catalogue. Ordre de confiance : 1) empreinte (SHA1, ou CRC32 + taille)
 * d'une ROM du catalogue ; 2) titre nettoyé égal à celui d'un jeu ; 3) rapprochement flou par mots, seulement s'il est sans ambiguïté
 * (le jeu doit contenir tous les mots de la source ou presque, les numéros de suite doivent être identiques, aucun concurrent proche).
 * Toute variante régionale/révision se résout vers l'entrée représentative (`dup = 0`), la seule qui a fiche et images.
 */
export class CatalogMatcher {
  private readonly cache = new Map<string, ConsoleIndex>()
  constructor(private readonly db: DatabaseSync) {}

  private index(console: string): ConsoleIndex {
    const hit = this.cache.get(console)
    if (hit) return hit
    const rows = this.db.prepare('SELECT id, title, name, base, dup, crc, sha1, size FROM catalog_games WHERE console = ?').all(console) as unknown as Row[]
    const repOfBase = new Map<string, number>()
    for (const r of rows) if (!r.dup && r.base) repOfBase.set(r.base, r.id)
    const repOf = (r: Row): number => (r.base ? repOfBase.get(r.base) : undefined) ?? r.id
    const idx: ConsoleIndex = { exact: new Map(), loose: new Map(), crc: new Map(), sha1: new Map(), groups: [], byToken: new Map() }
    const push = (m: Map<string, number[]>, k: string, id: number): void => { const a = m.get(k); if (!a) m.set(k, [id]); else if (!a.includes(id)) a.push(id) }
    const groups = new Map<number, Group>()
    const exactPass = (isRep: boolean): void => {
      // Les représentants passent d'abord : à clé égale, c'est le jeu visible qui gagne.
      for (const r of rows) {
        if (!!r.dup === isRep) continue
        const rep = repOf(r)
        for (const t of [r.title, r.name, ...r.title.split(/\s+~\s+/).slice(1), r.title.split(/\s+~\s+/)[0]]) {
          if (!t) continue
          const { strict, loose } = titleKeys(t)
          for (const k of strict) if (!idx.exact.has(k)) idx.exact.set(k, rep)
          for (const k of loose) if (!idx.loose.has(k)) idx.loose.set(k, rep)
        }
      }
    }
    exactPass(true)
    exactPass(false)
    for (const r of rows) {
      const rep = repOf(r)
      if (r.crc) { const k = r.crc.toUpperCase(); const a = idx.crc.get(k); const v = { rep, size: r.size }; if (a) a.push(v); else idx.crc.set(k, [v]) }
      if (r.sha1) push(idx.sha1, r.sha1.toUpperCase(), rep)
      if (r.dup) continue
      const toks = new Set(tokens(r.name ?? r.title))
      if (!toks.size) continue
      groups.set(rep, { rep, tokens: toks, digits: digitSig(toks) })
    }
    idx.groups = [...groups.values()]
    idx.groups.forEach((g, i) => { for (const t of g.tokens) { const a = idx.byToken.get(t); if (a) a.push(i); else idx.byToken.set(t, [i]) } })
    // Les hashs de lignes dup pointent aussi vers la représentative, y compris quand elle n'a pas de tokens.
    this.cache.set(console, idx)
    return idx
  }

  match(e: MatchInput): SourceMatch | null {
    const idx = this.index(e.console)
    const byHash = this.byHash(idx, e)
    if (byHash !== null) return { gameId: byHash, kind: 'hash' }
    const keys = alternatives(e.title).map(titleKeys)
    for (const { strict } of keys) for (const k of strict) { const id = idx.exact.get(k); if (id !== undefined) return { gameId: id, kind: 'title' } }
    for (const { strict, loose } of keys) for (const k of [...strict, ...loose]) { const id = idx.loose.get(k) ?? idx.exact.get(k); if (id !== undefined) return { gameId: id, kind: 'title' } }
    const risky = RISKY.test(e.title)
    const fuzzy = alternatives(e.title).slice(0, 3).map((t) => this.fuzzy(idx, t, risky)).find((id) => id !== null) ?? null
    return fuzzy !== null ? { gameId: fuzzy, kind: 'fuzzy' } : null
  }

  private byHash(idx: ConsoleIndex, e: MatchInput): number | null {
    const uniq = (ids: number[] | undefined): number | null => (ids && ids.length === 1 ? ids[0] : null)
    if (e.sha1) { const id = uniq(idx.sha1.get(e.sha1.toUpperCase())); if (id !== null) return id }
    if (e.crc && e.sizeBytes) {
      const ids = idx.crc.get(e.crc.toUpperCase())
      if (ids) {
        // Le CRC32 seul est trop court pour être fiable : la taille doit aussi correspondre.
        const reps = [...new Set(ids.filter((c) => c.size === e.sizeBytes).map((c) => c.rep))]
        if (reps.length === 1) return reps[0]
      }
    }
    return null
  }

  private fuzzy(idx: ConsoleIndex, title: string, risky: boolean): number | null {
    const toks = new Set(tokens(title))
    if (toks.size < 2) return null
    const sig = digitSig(toks)
    // Candidats : jeux partageant l'un des mots les plus rares de la source.
    const rare = [...toks].filter((t) => idx.byToken.has(t)).sort((a, b) => idx.byToken.get(a)!.length - idx.byToken.get(b)!.length).slice(0, 3)
    const cand = new Set<number>()
    for (const t of rare) for (const i of idx.byToken.get(t)!) cand.add(i)
    let best: { rep: number; score: number } | null = null
    let second = 0
    for (const i of cand) {
      const g = idx.groups[i]
      if (g.digits !== sig) continue
      let inter = 0
      for (const t of toks) if (g.tokens.has(t)) inter++
      if (inter < 2) continue
      const dice = (2 * inter) / (toks.size + g.tokens.size)
      const cover = inter / toks.size
      const precision = inter / g.tokens.size
      // Soit presque identiques, soit tous les mots de la source présents dans un titre plus long (sous-titre, éditeur en préfixe).
      // Dernier cas : le titre du catalogue est un préfixe plus court de la source (sous-titre ajouté) ; jamais pour un hack/démo/bêta.
      const ok = dice >= 0.85 || (cover === 1 && precision >= 0.3) || (!risky && precision === 1 && cover >= 0.5)
      if (!ok) continue
      const score = dice + (cover === 1 ? 0.1 : 0)
      if (!best || score > best.score) { if (best) second = Math.max(second, best.score); best = { rep: g.rep, score } } else second = Math.max(second, score)
    }
    return best && best.score - second >= 0.08 ? best.rep : null
  }
}
