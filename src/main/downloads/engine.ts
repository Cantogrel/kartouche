import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { DownloadProgress } from '@shared/downloads'

export type Report = (p: DownloadProgress) => void
export type HttpFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

const active = new Map<number, AbortController>()

/** Annule le téléchargement en cours de cette source, s'il y en a un (aucun effet sinon). */
export function cancelDownload(sourceId: number): void {
  active.get(sourceId)?.abort()
}

function filenameFromUri(uri: string): string {
  try {
    const base = new URL(uri).pathname.split('/').filter(Boolean).pop()
    return base && /\.[a-z0-9]{1,6}$/i.test(base) ? base : 'download.bin'
  } catch {
    return 'download.bin'
  }
}

/** Télécharge une URI vers `part`, en reprenant via Range si `part` existe déjà et que le serveur le permet. */
async function fetchOne(uri: string, part: string, sourceId: number, signal: AbortSignal, report: Report, httpFetch: HttpFetch): Promise<void> {
  let startAt = existsSync(part) ? statSync(part).size : 0
  const headers: Record<string, string> = { 'user-agent': 'RomVault' }
  if (startAt > 0) headers['range'] = `bytes=${startAt}-`

  const res = await httpFetch(uri, { headers, signal })
  if (!res.body || (res.status !== 200 && res.status !== 206)) throw new Error(`HTTP ${res.status}`)
  const resumed = res.status === 206
  if (startAt > 0 && !resumed) startAt = 0 // le serveur ne sait pas reprendre : on repart de zéro

  const contentLength = Number(res.headers.get('content-length') ?? 0)
  const total = resumed ? startAt + contentLength : contentLength
  let done = startAt
  let last = 0
  const src = Readable.fromWeb(res.body as never)
  src.on('data', (c: Buffer) => {
    done += c.length
    const now = Date.now()
    if (now - last > 150) { last = now; report({ sourceId, phase: 'downloading', done, total }) }
  })
  await pipeline(src, createWriteStream(part, { flags: resumed ? 'a' : 'w' }))
  report({ sourceId, phase: 'downloading', done, total })
}

/**
 * Télécharge la première URI utilisable d'une source vers `<cacheDir>/<sourceId>/<fichier>`. Un fichier `.part`
 * partiel survit à un échec réseau (repris au prochain appel) mais est retiré sur une annulation explicite.
 * Ne fait ni extraction ni vérification ni installation bibliothèque : uniquement le téléchargement (voir P05).
 */
export async function downloadSource(db: DatabaseSync, sourceId: number, cacheDir: string, report: Report, httpFetch: HttpFetch = fetch): Promise<{ ok: boolean; file?: string; error?: string }> {
  const row = db.prepare('SELECT uris FROM sources WHERE id = ?').get(sourceId) as { uris: string } | undefined
  if (!row) return { ok: false, error: 'source introuvable' }
  const uris = JSON.parse(row.uris) as string[]
  if (!uris.length) return { ok: false, error: 'aucun lien pour cette source' }

  const controller = new AbortController()
  active.set(sourceId, controller)
  let currentPart: string | null = null
  try {
    let lastError = ''
    for (const uri of uris) {
      const dir = join(cacheDir, String(sourceId))
      await mkdir(dir, { recursive: true })
      const dest = join(dir, filenameFromUri(uri))
      const part = `${dest}.part`
      currentPart = part
      try {
        await fetchOne(uri, part, sourceId, controller.signal, report, httpFetch)
        await rename(part, dest)
        report({ sourceId, phase: 'done', done: 1, total: 1 })
        return { ok: true, file: dest }
      } catch (e) {
        if (controller.signal.aborted) break
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    if (controller.signal.aborted) {
      if (currentPart) await rm(currentPart, { force: true }).catch(() => {})
      report({ sourceId, phase: 'canceled', done: 0, total: 0 })
      return { ok: false, error: 'annulé' }
    }
    report({ sourceId, phase: 'error', done: 0, total: 0, message: lastError })
    return { ok: false, error: lastError }
  } finally {
    active.delete(sourceId)
  }
}
