// Décodeur LZMA « brut » (flux sans en-tête de 13 octets, propriétés connues), utilisé pour lire les blocs des images CHD.
// Algorithme du SDK LZMA public (codeur par intervalles adaptatif + fenêtre glissante) ; la fenêtre est la sortie elle-même, tout le bloc tenant en mémoire.

const PROB_INIT = 1024
const TOP = 1 << 24

/** Décompresse `src` en exactement `outSize` octets (lc/lp/pb : propriétés LZMA). Lève une erreur si le flux est corrompu. */
export function lzmaDecode(src: Buffer, outSize: number, lc = 3, lp = 0, pb = 2): Buffer {
  const out = Buffer.alloc(outSize)
  let inPos = 0
  let range = 0xffffffff
  let code = 0
  // 5 premiers octets : un 0 puis les 4 octets du code initial.
  if (src.length < 5) throw new Error('flux LZMA trop court')
  inPos = 1
  for (let i = 0; i < 4; i++) code = ((code << 8) | src[inPos++]) >>> 0

  const next = (): number => (inPos < src.length ? src[inPos++] : 0)
  const normalize = (): void => { if (range < TOP) { range = (range << 8) >>> 0; code = ((code << 8) | next()) >>> 0 } }

  const decodeBit = (probs: Uint16Array, i: number): number => {
    normalize()
    const p = probs[i]
    const bound = (range >>> 11) * p
    if (code < bound) { range = bound >>> 0; probs[i] = p + ((2048 - p) >> 5); return 0 }
    range = (range - bound) >>> 0; code = (code - bound) >>> 0; probs[i] = p - (p >> 5)
    return 1
  }
  const direct = (n: number): number => {
    let r = 0
    for (; n > 0; n--) {
      normalize()
      range >>>= 1
      const bit = code >= range ? 1 : 0
      if (bit) code = (code - range) >>> 0
      r = ((r << 1) | bit) >>> 0
    }
    return r
  }
  const bitTree = (probs: Uint16Array, base: number, bits: number): number => {
    let m = 1
    for (let i = 0; i < bits; i++) m = (m << 1) | decodeBit(probs, base + m)
    return m - (1 << bits)
  }
  const bitTreeReverse = (probs: Uint16Array, base: number, bits: number): number => {
    let m = 1, sym = 0
    for (let i = 0; i < bits; i++) { const b = decodeBit(probs, base + m); m = (m << 1) | b; sym |= b << i }
    return sym
  }

  const literal = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT)
  const isMatch = new Uint16Array(12 << 4).fill(PROB_INIT)
  const isRep = new Uint16Array(12).fill(PROB_INIT)
  const isRepG0 = new Uint16Array(12).fill(PROB_INIT)
  const isRepG1 = new Uint16Array(12).fill(PROB_INIT)
  const isRepG2 = new Uint16Array(12).fill(PROB_INIT)
  const isRep0Long = new Uint16Array(12 << 4).fill(PROB_INIT)
  const posSlot = new Uint16Array(4 << 6).fill(PROB_INIT)
  const posSpecial = new Uint16Array(115).fill(PROB_INIT)
  const align = new Uint16Array(16).fill(PROB_INIT)
  // Longueurs : [choice, choice2, low[16][8], mid[16][8], high[256]]
  const mkLen = (): { choice: Uint16Array; low: Uint16Array; mid: Uint16Array; high: Uint16Array } => ({
    choice: new Uint16Array(2).fill(PROB_INIT), low: new Uint16Array(16 << 3).fill(PROB_INIT), mid: new Uint16Array(16 << 3).fill(PROB_INIT), high: new Uint16Array(256).fill(PROB_INIT)
  })
  const lenDec = mkLen()
  const repLenDec = mkLen()
  const decodeLen = (l: ReturnType<typeof mkLen>, posState: number): number => {
    if (decodeBit(l.choice, 0) === 0) return bitTree(l.low, posState << 3, 3)
    if (decodeBit(l.choice, 1) === 0) return 8 + bitTree(l.mid, posState << 3, 3)
    return 16 + bitTree(l.high, 0, 8)
  }

  let state = 0
  let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0
  let pos = 0
  const pbMask = (1 << pb) - 1
  const lpMask = (1 << lp) - 1

  while (pos < outSize) {
    const posState = pos & pbMask
    if (decodeBit(isMatch, (state << 4) + posState) === 0) {
      const prev = pos > 0 ? out[pos - 1] : 0
      const base = 0x300 * (((pos & lpMask) << lc) + (prev >> (8 - lc)))
      let sym = 1
      if (state >= 7) {
        let matchByte = out[pos - rep0 - 1]
        while (sym < 0x100) {
          const matchBit = (matchByte >> 7) & 1
          matchByte <<= 1
          const bit = decodeBit(literal, base + ((1 + matchBit) << 8) + sym)
          sym = (sym << 1) | bit
          if (matchBit !== bit) break
        }
      }
      while (sym < 0x100) sym = (sym << 1) | decodeBit(literal, base + sym)
      out[pos++] = sym & 0xff
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6
      continue
    }
    let len: number
    if (decodeBit(isRep, state) === 1) {
      if (pos === 0) throw new Error('flux LZMA invalide')
      if (decodeBit(isRepG0, state) === 0) {
        if (decodeBit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11
          out[pos] = out[pos - rep0 - 1]; pos++
          continue
        }
      } else {
        let dist: number
        if (decodeBit(isRepG1, state) === 0) dist = rep1
        else if (decodeBit(isRepG2, state) === 0) { dist = rep2; rep2 = rep1 }
        else { dist = rep3; rep3 = rep2; rep2 = rep1 }
        rep1 = rep0; rep0 = dist
      }
      len = decodeLen(repLenDec, posState)
      state = state < 7 ? 8 : 11
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0
      len = decodeLen(lenDec, posState)
      state = state < 7 ? 7 : 10
      const lenState = Math.min(len, 3)
      const slot = bitTree(posSlot, lenState << 6, 6)
      if (slot < 4) rep0 = slot
      else {
        const numDirect = (slot >> 1) - 1
        rep0 = ((2 | (slot & 1)) << numDirect) >>> 0
        if (slot < 14) rep0 = (rep0 + bitTreeReverse(posSpecial, rep0 - slot - 1, numDirect)) >>> 0
        else {
          rep0 = (rep0 + (direct(numDirect - 4) << 4)) >>> 0
          rep0 = (rep0 + bitTreeReverse(align, 0, 4)) >>> 0
          if (rep0 === 0xffffffff) break // marqueur de fin
        }
      }
    }
    len += 2
    if (rep0 >= pos) throw new Error('flux LZMA invalide (distance)')
    for (let i = 0; i < len && pos < outSize; i++, pos++) out[pos] = out[pos - rep0 - 1]
  }
  return out
}
