/**
 * Lecteur LevelDB minimal, en lecture seule, pour la base locale d'un launcher (Hydra). Il comprend les fichiers `.log` (écritures récentes) et `.ldb`
 * (tables, compressées avec Snappy) et renvoie, pour chaque clé, sa dernière valeur non supprimée. Tolérant : un fichier tronqué ou abîmé est lu
 * jusqu'où c'est possible, jamais d'exception ; il n'écrit rien et ne prend aucun verrou.
 */

export interface LevelEntry { key: Buffer; value: Buffer; seq: bigint }

function varint(b: Buffer, pos: number): [number, number] | null {
  let result = 0
  let shift = 0
  for (let i = 0; i < 5; i++) {
    if (pos + i >= b.length) return null
    const byte = b[pos + i]
    result += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) return [result, pos + i + 1]
    shift += 7
  }
  return null
}

/** Décompression Snappy (format brut). null si les données sont incohérentes. */
export function snappyDecompress(src: Buffer): Buffer | null {
  const head = varint(src, 0)
  if (!head) return null
  const [outLen, start] = head
  if (outLen > 64 * 1024 * 1024) return null
  const out = Buffer.alloc(outLen)
  let o = 0
  let i = start
  while (i < src.length) {
    const tag = src[i++]
    const kind = tag & 3
    if (kind === 0) {
      let len = tag >> 2
      if (len >= 60) {
        const n = len - 59
        if (i + n > src.length) return null
        len = 0
        for (let k = 0; k < n; k++) len += src[i + k] * 2 ** (8 * k)
        i += n
      }
      len += 1
      if (i + len > src.length || o + len > outLen) return null
      src.copy(out, o, i, i + len)
      o += len; i += len
    } else {
      let len: number
      let offset: number
      if (kind === 1) {
        if (i >= src.length) return null
        len = 4 + ((tag >> 2) & 7)
        offset = ((tag >> 5) << 8) | src[i++]
      } else if (kind === 2) {
        if (i + 2 > src.length) return null
        len = 1 + (tag >> 2)
        offset = src.readUInt16LE(i); i += 2
      } else {
        if (i + 4 > src.length) return null
        len = 1 + (tag >> 2)
        offset = src.readUInt32LE(i); i += 4
      }
      if (offset === 0 || offset > o || o + len > outLen) return null
      for (let k = 0; k < len; k++) out[o + k] = out[o - offset + k]
      o += len
    }
  }
  return o === outLen ? out : null
}

/** Entrées d'un fichier `.log` : lots d'écriture (WriteBatch) répartis en enregistrements de blocs de 32 Ko. */
export function readLog(buf: Buffer): LevelEntry[] {
  const BLOCK = 32768
  const entries: LevelEntry[] = []
  let pending: Buffer[] = []
  const batch = (data: Buffer): void => {
    if (data.length < 12) return
    const seq = data.readBigUInt64LE(0)
    const count = data.readUInt32LE(8)
    let pos = 12
    for (let n = 0; n < count && pos < data.length; n++) {
      const type = data[pos++]
      const k = varint(data, pos); if (!k) return
      const key = data.subarray(k[1], k[1] + k[0]); pos = k[1] + k[0]
      if (type === 1) {
        const v = varint(data, pos); if (!v) return
        entries.push({ key: Buffer.from(key), value: Buffer.from(data.subarray(v[1], v[1] + v[0])), seq: seq + BigInt(n) }); pos = v[1] + v[0]
      } else if (type === 0) entries.push({ key: Buffer.from(key), value: Buffer.alloc(0), seq: seq + BigInt(n) | (1n << 62n) })
      else return
    }
  }
  for (let blockStart = 0; blockStart < buf.length; blockStart += BLOCK) {
    let pos = blockStart
    const end = Math.min(blockStart + BLOCK, buf.length)
    while (pos + 7 <= end) {
      const len = buf.readUInt16LE(pos + 4)
      const type = buf[pos + 6]
      if (type === 0 && len === 0) break
      if (pos + 7 + len > end) break
      const payload = buf.subarray(pos + 7, pos + 7 + len)
      pos += 7 + len
      if (type === 1) batch(payload)
      else if (type === 2) pending = [payload]
      else if (type === 3) pending.push(payload)
      else if (type === 4) { pending.push(payload); batch(Buffer.concat(pending)); pending = [] }
    }
  }
  return entries
}

function blockEntries(block: Buffer): { key: Buffer; value: Buffer }[] {
  const out: { key: Buffer; value: Buffer }[] = []
  if (block.length < 4) return out
  const restarts = block.readUInt32LE(block.length - 4)
  const limit = block.length - 4 - restarts * 4
  if (limit < 0) return out
  let pos = 0
  let key: Buffer = Buffer.alloc(0)
  while (pos < limit) {
    const a = varint(block, pos); if (!a) break
    const b = varint(block, a[1]); if (!b) break
    const c = varint(block, b[1]); if (!c) break
    const shared = a[0]; const nonShared = b[0]; const vlen = c[0]
    if (shared > key.length || c[1] + nonShared + vlen > limit) break
    key = Buffer.concat([key.subarray(0, shared), block.subarray(c[1], c[1] + nonShared)])
    out.push({ key, value: block.subarray(c[1] + nonShared, c[1] + nonShared + vlen) })
    pos = c[1] + nonShared + vlen
  }
  return out
}

function readBlock(file: Buffer, offset: number, size: number): Buffer | null {
  if (offset + size + 5 > file.length) return null
  const raw = file.subarray(offset, offset + size)
  const compression = file[offset + size]
  if (compression === 0) return raw
  if (compression === 1) return snappyDecompress(raw)
  return null
}

/** Entrées d'un fichier `.ldb` (table triée). */
export function readTable(file: Buffer): LevelEntry[] {
  const entries: LevelEntry[] = []
  if (file.length < 48) return entries
  const footer = file.subarray(file.length - 48)
  const meta = varint(footer, 0); if (!meta) return entries
  const metaSize = varint(footer, meta[1]); if (!metaSize) return entries
  const idxOff = varint(footer, metaSize[1]); if (!idxOff) return entries
  const idxSize = varint(footer, idxOff[1]); if (!idxSize) return entries
  const index = readBlock(file, idxOff[0], idxSize[0])
  if (!index) return entries
  for (const handle of blockEntries(index)) {
    const off = varint(handle.value, 0); if (!off) continue
    const size = varint(handle.value, off[1]); if (!size) continue
    const data = readBlock(file, off[0], size[0])
    if (!data) continue
    for (const e of blockEntries(data)) {
      if (e.key.length < 8) continue
      const tag = e.key.readBigUInt64LE(e.key.length - 8)
      const type = Number(tag & 0xffn)
      const seq = tag >> 8n
      entries.push({ key: Buffer.from(e.key.subarray(0, e.key.length - 8)), value: type === 1 ? Buffer.from(e.value) : Buffer.alloc(0), seq: type === 1 ? seq : seq | (1n << 62n) })
    }
  }
  return entries
}

/** Dernière valeur de chaque clé (une suppression l'emporte si elle est plus récente) : clé → valeur. */
export function latestValues(parts: LevelEntry[][]): Map<string, Buffer> {
  const best = new Map<string, LevelEntry>()
  const seqOf = (e: LevelEntry): bigint => e.seq & ((1n << 62n) - 1n)
  for (const list of parts) {
    for (const e of list) {
      const k = e.key.toString('latin1')
      const cur = best.get(k)
      if (!cur || seqOf(e) >= seqOf(cur)) best.set(k, e)
    }
  }
  const out = new Map<string, Buffer>()
  for (const [k, e] of best) if (!(e.seq & (1n << 62n))) out.set(Buffer.from(k, 'latin1').toString('utf-8'), e.value)
  return out
}
