import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DatabaseSync } from 'node:sqlite'
import type { DownloadProgress } from '@shared/downloads'
import { uriKind } from '@shared/uriKind'
import { downloadTorrent, fetchTorrentFile } from './torrent'
import { remoteWuaProblem } from './precheck'
import { VWII_REASON } from '../library/content/wua'

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
 * Source BitTorrent (magnet ou URL .torrent). Un seul fichier retenu : déplacé à plat dans `dir`, dossier de travail du client supprimé. Plusieurs (disque et ses
 * pistes, jeu et ses mises à jour/DLC — voir `planTorrent`) : laissés dans leur dossier de travail avec leur arborescence (un .cue référence ses pistes par chemin) ;
 * l'appelant les installe puis supprime le dossier.
 */
async function fetchTorrent(uri: string, kind: 'magnet' | 'torrent', work: string, dir: string, row: { title: string; size_bytes: number | null; console: string }, sourceId: number, signal: AbortSignal, report: Report, httpFetch: HttpFetch, dhtCacheFile: string): Promise<string[]> {
  const input = kind === 'magnet' ? uri : await fetchTorrentFile(uri, signal, httpFetch)
  const got = await downloadTorrent({
    input, workDir: work, title: row.title, sizeBytes: row.size_bytes, consoleId: row.console, signal, dhtCacheFile,
    onProgress: (done, total) => report({ sourceId, phase: 'downloading', done, total, message: total ? undefined : 'connecting' })
  })
  if (got.length > 1) return got
  const dest = join(dir, basename(got[0]))
  await rename(got[0], dest)
  await rm(work, { recursive: true, force: true })
  return [dest]
}

/**
 * Télécharge la première URI utilisable d'une source vers `<cacheDir>/<sourceId>/<fichier>`. Un fichier `.part`
 * (ou dossier de travail BitTorrent) partiel survit à un échec réseau (repris au prochain appel) mais est retiré sur une annulation explicite.
 * Ne fait ni extraction ni vérification ni installation bibliothèque : uniquement le téléchargement (voir P05).
 */
export async function downloadSource(db: DatabaseSync, sourceId: number, cacheDir: string, report: Report, httpFetch: HttpFetch = fetch): Promise<{ ok: boolean; file?: string; /** Tous les fichiers retenus (le principal en premier) : plusieurs pour un torrent dont le disque ou le jeu en demande davantage. */ files?: string[]; error?: string }> {
  const row = db.prepare('SELECT uris, title, size_bytes, console FROM sources WHERE id = ?').get(sourceId) as { uris: string; title: string; size_bytes: number | null; console: string } | undefined
  if (!row) return { ok: false, error: 'source introuvable' }
  const uris = JSON.parse(row.uris) as string[]
  if (!uris.length) return { ok: false, error: 'aucun lien pour cette source' }

  const controller = new AbortController()
  active.set(sourceId, controller)
  let currentPart: string | null = null
  try {
    let lastError = ''
    for (const [i, uri] of uris.entries()) {
      const dir = join(cacheDir, String(sourceId))
      await mkdir(dir, { recursive: true })
      const kind = uriKind(uri)
      try {
        let dest: string
        let files: string[] | undefined
        if (kind === 'http') {
          dest = join(dir, filenameFromUri(uri))
          const part = `${dest}.part`
          currentPart = part
          // Titre Wii (vWii) emballé pour Wii U : repéré par quelques octets de fin d'archive, avant de télécharger des Go inutilisables.
          if (row.console === 'wiiu') { const bad = await remoteWuaProblem(uri, controller.signal, httpFetch); if (bad) throw new Error(bad) }
          await fetchOne(uri, part, sourceId, controller.signal, report, httpFetch)
          await rename(part, dest)
        } else {
          const work = join(dir, `torrent-${i}`)
          currentPart = work
          files = await fetchTorrent(uri, kind, work, dir, row, sourceId, controller.signal, report, httpFetch, join(cacheDir, 'dht-nodes.json'))
          dest = files[0]
        }
        report({ sourceId, phase: 'done', done: 1, total: 1 })
        return { ok: true, file: dest, files: files ?? [dest] }
      } catch (e) {
        if (controller.signal.aborted) break
        lastError = e instanceof Error ? e.message : String(e)
        // Titre vWii refusé : rien à reprendre plus tard, on libère aussitôt ce que la lecture de fin d'archive a alloué (un torrent préalloue la taille du fichier).
        if (lastError === VWII_REASON && currentPart) await rm(currentPart, { recursive: true, force: true }).catch(() => {})
      }
    }
    if (controller.signal.aborted) {
      if (currentPart) await rm(currentPart, { recursive: true, force: true }).catch(() => {})
      report({ sourceId, phase: 'canceled', done: 0, total: 0 })
      return { ok: false, error: 'annulé' }
    }
    report({ sourceId, phase: 'error', done: 0, total: 0, message: lastError })
    return { ok: false, error: lastError }
  } finally {
    active.delete(sourceId)
  }
}
