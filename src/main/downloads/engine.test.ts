import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import type { DownloadProgress } from '@shared/downloads'
import { cancelDownload, downloadSource, type HttpFetch } from './engine'

let db: DatabaseSync
let cacheDir: string
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  cacheDir = mktemp()
  db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('L', 'https://x/l.json', 0)").run()
})
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }))

function mktemp(): string { return mkdtempSync(join(tmpdir(), 'rv-dl-')) }

const addSource = (uris: string[]): number => {
  db.prepare("INSERT INTO sources (list_id, console, title, uris) VALUES (1, 'snes', 'Jeu', ?)").run(JSON.stringify(uris))
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}

/** Fetcher simulé : diffuse `bytes` en petits blocs. `respectRange` gère un Range demandé ; `breakAfter` coupe le flux (erreur réseau, pas une annulation). */
function fakeFetch(bytes: Uint8Array, opts: { status?: number; breakAfter?: number; abortable?: boolean } = {}): HttpFetch {
  return async (_url, init) => {
    if (init.signal.aborted) throw new DOMException('aborted', 'AbortError')
    const range = init.headers['range']
    const start = range ? Number(range.match(/bytes=(\d+)-/)?.[1] ?? 0) : 0
    const slice = bytes.subarray(start)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let i = 0
        const CHUNK = 4
        const pump = (): void => {
          if (opts.abortable && init.signal.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return }
          if (opts.breakAfter !== undefined && i >= opts.breakAfter) { controller.error(new Error('ECONNRESET')); return }
          if (i >= slice.length) { controller.close(); return }
          controller.enqueue(slice.subarray(i, i + CHUNK))
          i += CHUNK
          setTimeout(pump, 2)
        }
        if (opts.abortable) init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        pump()
      }
    })
    return new Response(body, { status: opts.status ?? (range ? 206 : 200), headers: { 'content-length': String(slice.length) } })
  }
}

const FULL = new TextEncoder().encode('0123456789ABCDEFGHIJ') // 20 octets

describe('downloadSource', () => {
  it('télécharge un fichier de bout en bout, avec progression', async () => {
    const id = addSource(['https://x/rom.zip'])
    const progress: DownloadProgress[] = []
    const result = await downloadSource(db, id, cacheDir, (p) => progress.push(p), fakeFetch(FULL))
    expect(result.ok).toBe(true)
    expect(readFileSync(result.file!)).toEqual(Buffer.from(FULL))
    expect(progress.at(-1)).toMatchObject({ phase: 'done' })
  })

  it('reprend après une coupure réseau sans recommencer de zéro', async () => {
    const id = addSource(['https://x/rom.zip'])
    const cut = await downloadSource(db, id, cacheDir, () => {}, fakeFetch(FULL, { breakAfter: 8 }))
    expect(cut.ok).toBe(false)
    const partPath = join(cacheDir, String(id), 'rom.zip.part')
    expect(existsSync(partPath)).toBe(true)
    const partialSize = readFileSync(partPath).length
    expect(partialSize).toBeGreaterThan(0)
    expect(partialSize).toBeLessThan(FULL.length)

    const resumed = await downloadSource(db, id, cacheDir, () => {}, fakeFetch(FULL))
    expect(resumed.ok).toBe(true)
    expect(readFileSync(resumed.file!)).toEqual(Buffer.from(FULL)) // recollé, pas retéléchargé depuis 0
  })

  it("l'annulation nettoie le fichier partiel", async () => {
    const id = addSource(['https://x/rom.zip'])
    const promise = downloadSource(db, id, cacheDir, () => {}, fakeFetch(FULL, { abortable: true }))
    await new Promise((r) => setTimeout(r, 10)) // laisse le premier chunk s'écrire
    cancelDownload(id)
    const result = await promise
    expect(result.ok).toBe(false)
    expect(existsSync(join(cacheDir, String(id), 'rom.zip.part'))).toBe(false)
  })

  it('essaie le mirroir suivant si le premier échoue', async () => {
    const id = addSource(['https://x/mort.zip', 'https://x/rom.zip'])
    let call = 0
    const httpFetch: HttpFetch = async (url, init) => {
      call++
      if (url.includes('mort')) throw new Error('DNS')
      return fakeFetch(FULL)(url, init)
    }
    const result = await downloadSource(db, id, cacheDir, () => {}, httpFetch)
    expect(result.ok).toBe(true)
    expect(call).toBe(2)
  })

  it('source introuvable ou sans lien : erreur claire, pas de crash', async () => {
    expect((await downloadSource(db, 999, cacheDir, () => {}, fakeFetch(FULL))).error).toMatch(/introuvable/)
    const id = addSource([])
    expect((await downloadSource(db, id, cacheDir, () => {}, fakeFetch(FULL))).error).toMatch(/aucun lien/)
  })
})
