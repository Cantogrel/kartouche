export interface DatGame {
  name: string
  comment?: string
  region?: string
  genre?: string
  releaseyear?: string
  developer?: string
  rom: { name?: string; size?: string; crc?: string; sha1?: string }
}

const FIELD = /^\s*(\w+)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))\s*$/
const ROM = /^\s*rom\s*\(\s*(.*?)\s*\)\s*$/
const ROM_PAIR = /(\w+)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))/g

/** Analyse un DAT au format clrmamepro (blocs `game ( … )`) : ligne à ligne, tolérant aux champs inconnus. */
export function parseDat(text: string): DatGame[] {
  const games: DatGame[] = []
  let cur: DatGame | null = null
  for (const line of text.split(/\r?\n/)) {
    if (cur === null) {
      if (/^game\s*\(\s*$/.test(line)) cur = { name: '', rom: {} }
      continue
    }
    if (/^\)\s*$/.test(line)) {
      if (cur.name || cur.comment) games.push(cur)
      cur = null
      continue
    }
    const rom = ROM.exec(line)
    if (rom) {
      for (const m of rom[1].matchAll(ROM_PAIR)) (cur.rom as Record<string, string>)[m[1]] = m[2] ?? m[3]
      continue
    }
    const f = FIELD.exec(line)
    if (f) (cur as unknown as Record<string, string>)[f[1]] = f[2] ?? f[3]
  }
  return games
}

const VARIANT = /\((?:Beta|Proto|Demo|Sample|Pirate|Unl|Kiosk|Promo|Alt|Debug|Program|Test)\b/i
export const isVariant = (title: string): boolean => VARIANT.test(title)

/** Les DAT genre/année/développeur identifient un jeu par `comment` (= nom du jeu) ; retourne nom → valeur. */
export function metaByTitle(games: DatGame[], field: 'genre' | 'releaseyear' | 'developer'): Map<string, string> {
  const map = new Map<string, string>()
  for (const g of games) {
    const key = g.comment ?? g.name
    const v = g[field]
    if (key && v) map.set(key, v)
  }
  return map
}
