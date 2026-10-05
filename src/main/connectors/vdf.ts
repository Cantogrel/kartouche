/**
 * Lecture du format texte de Valve (VDF/ACF : `"clé" "valeur"` et blocs `{ }`), utilisé par les manifestes de Steam. Tolérant : un fichier tronqué ou
 * abîmé donne ce qui a pu être lu, jamais une exception.
 */
export type VdfValue = string | VdfObject
export interface VdfObject { [key: string]: VdfValue }

function tokenize(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let s = ''
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) { i++; const n = text[i]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n } else s += text[i]
        i++
      }
      i++
      out.push(`s${s}`)
    } else if (c === '{' || c === '}') { out.push(c); i++ }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++ }
    else i++
  }
  return out
}

export function parseVdf(text: string): VdfObject {
  const tokens = tokenize(text)
  let pos = 0
  const block = (): VdfObject => {
    const obj: VdfObject = {}
    while (pos < tokens.length) {
      const t = tokens[pos++]
      if (t === '}') return obj
      if (t === '{' || !t.startsWith('s')) continue
      const key = t.slice(1)
      const next = tokens[pos]
      if (next === '{') { pos++; obj[key] = block() }
      else if (next !== undefined && next.startsWith('s')) { pos++; obj[key] = next.slice(1) }
    }
    return obj
  }
  return block()
}

export const vdfString = (v: VdfValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined)
export const vdfObject = (v: VdfValue | undefined): VdfObject | undefined => (v && typeof v === 'object' ? v : undefined)
