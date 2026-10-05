import { describe, expect, it } from 'vitest'
import { gameFromHydra, hydraConnector, realHydraDeps, type HydraDeps } from './hydra'
import { latestValues, readLog, readTable, snappyDecompress } from './leveldb'

const vi = (n: number): Buffer => { const out: number[] = []; while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128) } out.push(n); return Buffer.from(out) }

/** Fichier .log : un enregistrement complet par lot d'écritures. */
function logFile(batches: { seq: number; ops: { key: string; value?: string }[] }[]): Buffer {
  const recs = batches.map((b) => {
    const parts: Buffer[] = []
    const head = Buffer.alloc(12); head.writeBigUInt64LE(BigInt(b.seq)); head.writeUInt32LE(b.ops.length, 8)
    parts.push(head)
    for (const op of b.ops) {
      const k = Buffer.from(op.key)
      if (op.value === undefined) parts.push(Buffer.from([0]), vi(k.length), k)
      else { const v = Buffer.from(op.value); parts.push(Buffer.from([1]), vi(k.length), k, vi(v.length), v) }
    }
    const data = Buffer.concat(parts)
    const h = Buffer.alloc(7); h.writeUInt16LE(data.length, 4); h[6] = 1
    return Buffer.concat([h, data])
  })
  return Buffer.concat(recs)
}

/** Élément littéral Snappy. */
const literal = (b: Buffer): Buffer => {
  const n = b.length - 1
  const head = n < 60 ? Buffer.from([n << 2]) : n < 256 ? Buffer.from([60 << 2, n]) : Buffer.from([61 << 2, n & 0xff, n >> 8])
  return Buffer.concat([head, b])
}

/** Fichier .ldb à un seul bloc de données, compressé ou non (Snappy en littéraux seuls). */
function tableFile(rows: { key: string; value: string; seq: number; del?: boolean }[], snappy: boolean): Buffer {
  const entries: Buffer[] = []
  for (const r of rows) {
    const tag = Buffer.alloc(8); tag.writeBigUInt64LE((BigInt(r.seq) << 8n) | (r.del ? 0n : 1n))
    const k = Buffer.concat([Buffer.from(r.key), tag]); const v = Buffer.from(r.value)
    entries.push(vi(0), vi(k.length), vi(v.length), k, v)
  }
  const restarts = Buffer.alloc(8); restarts.writeUInt32LE(0, 0); restarts.writeUInt32LE(1, 4)
  const block = Buffer.concat([...entries, restarts])
  const wrap = (b: Buffer, compress: boolean): Buffer => {
    let body = b
    if (compress) body = Buffer.concat([vi(b.length), literal(b)])
    return Buffer.concat([body, Buffer.from([compress ? 1 : 0, 0, 0, 0, 0])])
  }
  const data = wrap(block, snappy)
  const handle = Buffer.concat([vi(0), vi(data.length - 5)])
  const idxEntry = Buffer.concat([vi(0), vi(1), vi(handle.length), Buffer.from('z'), handle])
  const idx = Buffer.concat([idxEntry, restarts])
  const idxBlock = wrap(idx, false)
  const idxHandle = Buffer.concat([vi(data.length), vi(idx.length)])
  const footer = Buffer.alloc(48)
  Buffer.concat([vi(0), vi(0), idxHandle]).copy(footer)
  return Buffer.concat([data, idxBlock, footer])
}

const game = (title: string, exe: string | null, extra: Record<string, unknown> = {}): string => JSON.stringify({ title, objectId: '1', shop: 'steam', executablePath: exe, isDeleted: false, ...extra })

describe('leveldb', () => {
  it('Snappy : littéraux et copies', () => {
    // « abcabcabc » : littéral « abc » puis copie de 6 octets à distance 3.
    const src = Buffer.concat([vi(9), Buffer.from([2 << 2]), Buffer.from('abc'), Buffer.from([((6 - 4) << 2) | 1, 3])])
    expect(snappyDecompress(src)?.toString()).toBe('abcabcabc')
    expect(snappyDecompress(Buffer.from([5, 0xff]))).toBeNull()
  })
  it('.log : lots, mises à jour et suppressions', () => {
    const log = logFile([{ seq: 1, ops: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] }, { seq: 3, ops: [{ key: 'a', value: '3' }, { key: 'b' }] }])
    const m = latestValues([readLog(log)])
    expect([...m.entries()].map(([k, v]) => [k, v.toString()])).toEqual([['a', '3']])
  })
  it('.ldb : table lue avec ou sans Snappy, la plus récente l’emporte sur la plus ancienne', () => {
    const rows = [{ key: 'k1', value: 'v1', seq: 5 }, { key: 'k2', value: 'v2', seq: 6 }]
    for (const snappy of [false, true]) {
      expect(readTable(tableFile(rows, snappy)).map((e) => [e.key.toString(), e.value.toString()])).toEqual([['k1', 'v1'], ['k2', 'v2']])
    }
    const merged = latestValues([readTable(tableFile(rows, false)), readLog(logFile([{ seq: 10, ops: [{ key: 'k1', value: 'neuf' }] }]))])
    expect(merged.get('k1')?.toString()).toBe('neuf')
    expect(merged.get('k2')?.toString()).toBe('v2')
  })
  it('fichiers tronqués ou illisibles : rien d’exceptionnel', () => {
    expect(readTable(Buffer.from('trop court'))).toEqual([])
    expect(readTable(Buffer.alloc(200, 7))).toEqual([])
    expect(readLog(Buffer.alloc(100, 9))).toEqual([])
    const log = logFile([{ seq: 1, ops: [{ key: 'a', value: '1' }] }])
    expect(() => readLog(log.subarray(0, log.length - 3))).not.toThrow()
  })
})

describe('gameFromHydra', () => {
  it('reprend un jeu installé avec son exécutable', () => {
    expect(gameFromHydra('!games!steam:359310', game('Evoland 2', 'C:\\Games\\Library\\Evoland 2\\Evoland2.exe'))).toEqual({
      nativeId: 'steam:359310', title: 'Evoland 2', exe: 'C:\\Games\\Library\\Evoland 2\\Evoland2.exe', installDir: 'C:\\Games\\Library\\Evoland 2', cwd: 'C:\\Games\\Library\\Evoland 2'
    })
  })
  it('écarte les jeux sans exécutable (non installés), supprimés ou illisibles', () => {
    expect(gameFromHydra('!games!steam:1', game('A', null))).toBeNull()
    expect(gameFromHydra('!games!steam:1', game('A', 'C:\\a.exe', { isDeleted: true }))).toBeNull()
    expect(gameFromHydra('!games!steam:1', 'nimporte quoi')).toBeNull()
  })
})

describe('hydraConnector', () => {
  const deps = (files: Record<string, Buffer>): HydraDeps => ({ dbDir: () => 'DB', listDir: async () => Object.keys(files), readFile: async (p) => files[p.replace(/^DB[\\/]/, '')] ?? null })
  it('lit la table des jeux dans le .log et le .ldb, ignore les autres tables', async () => {
    const c = hydraConnector(deps({
      '000001.ldb': tableFile([{ key: '!games!steam:1', value: game('Jeu A', 'C:\\a.exe'), seq: 1 }, { key: '!games!steam:2', value: game('Jeu B', 'C:\\b.exe'), seq: 2 }], true),
      '000002.log': logFile([{ seq: 5, ops: [{ key: '!games!steam:2' }, { key: '!games!steam:3', value: game('Jeu C', 'C:\\c.exe') }, { key: '!downloads!x', value: game('Pas un jeu', 'C:\\x.exe') }] }]),
      'CURRENT': Buffer.from('MANIFEST')
    }))
    expect(await c.detect()).toBe(true)
    expect((await c.scan() as { title: string }[]).map((g) => g.title).sort()).toEqual(['Jeu A', 'Jeu C'])
  })
  it('Hydra absent', async () => {
    const c = hydraConnector({ dbDir: () => null, listDir: async () => [], readFile: async () => null })
    expect(await c.detect()).toBe(false)
    expect(await c.scan()).toEqual([])
  })
})

describe.runIf(process.platform === 'win32')('Hydra réel (lecture seule, si installé)', () => {
  it('lit la base réelle', async () => {
    if (!realHydraDeps.dbDir()) return
    const games = (await hydraConnector().scan()) as { title: string; exe: string; nativeId: string }[]
    for (const g of games) { expect(g.title).toBeTruthy(); expect(g.exe).toMatch(/\.exe$/i); expect(g.nativeId).toContain(':') }
  })
})
