import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

/**
 * Support BitTorrent du téléchargeur (client WebTorrent embarqué, MIT, aucun logiciel externe). RomVault ne fournit
 * ni magnet, ni tracker, ni .torrent : seules les URI des listes ajoutées par l'utilisateur sont utilisées, et seuls
 * les trackers/pairs qu'elles portent (le DHT public fait partie du protocole, pas d'une source fournie par RomVault).
 */

export { uriKind, type UriKind } from '@shared/uriKind'

const JUNK = /\.(nfo|txt|md|url|jpe?g|png|gif|sfv|md5|sha1|diz|lnk|html?)$/i
const stem = (name: string): string => name.replace(/\.[a-z0-9]{1,6}$/i, '')
const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export interface TorrentFileInfo { name: string; length: number }

/**
 * Choisit, dans un torrent multi-fichiers, le fichier qui correspond à l'entrée de source demandée, à partir de ce
 * que la liste déclare déjà (`sizeBytes`, `title`) — jamais « le premier » par défaut. Renvoie l'index, ou `null` si
 * plusieurs fichiers restent aussi plausibles (l'appelant remonte alors une erreur claire plutôt que de deviner).
 */
export function pickTorrentFile(files: TorrentFileInfo[], title: string, sizeBytes: number | null): number | null {
  if (files.length === 1) return 0
  let cand = files.map((_, i) => i)
  const real = cand.filter((i) => !JUNK.test(files[i].name))
  if (real.length) cand = real
  if (cand.length === 1) return cand[0]

  if (sizeBytes) {
    const bySize = cand.filter((i) => files[i].length === sizeBytes)
    if (bySize.length === 1) return bySize[0]
    if (bySize.length > 1) cand = bySize
  }

  const t = norm(title)
  const tTokens = new Set(t.split(' ').filter(Boolean))
  const score = (i: number): number => {
    const n = norm(stem(files[i].name))
    if (n === t) return 3
    if (n.length >= 3 && t.length >= 3 && (` ${n} `.includes(` ${t} `) || ` ${t} `.includes(` ${n} `))) return 2
    const nTokens = new Set(n.split(' ').filter(Boolean))
    const common = [...nTokens].filter((x) => tTokens.has(x)).length
    const union = new Set([...nTokens, ...tTokens]).size
    return union && common / union >= 0.6 ? 1 : 0
  }
  const scored = cand.map((i) => ({ i, s: score(i) })).sort((a, b) => b.s - a.s)
  if (scored[0].s > 0 && scored[0].s > (scored[1]?.s ?? -1)) return scored[0].i
  // Titre ne départage pas : la taille seule peut encore le faire si elle est unique parmi tous les fichiers réels
  return null
}

// Types minimaux de la partie de l'API WebTorrent utilisée (le paquet n'embarque pas de .d.ts).
interface WtFile { name: string; path: string; length: number; offset: number; done: boolean; select(): void }
interface WtTorrent {
  files: WtFile[]
  bitfield: { get(i: number): boolean } | null
  pieces: ({ missing: number } | null)[]
  pieceLength: number
  lastPieceLength: number
  on(ev: string, cb: (...a: unknown[]) => void): void
}
interface WtClient {
  add(id: string | Buffer, opts: { path: string; deselect: boolean }): WtTorrent
  on(ev: string, cb: (e: unknown) => void): void
  destroy(cb: (err?: unknown) => void): void
}

let clientOptions: Record<string, unknown> = {}
/** Tests seulement : options du client (pas de DHT, de tracker ni d'UPnP publics). */
export function setTorrentClientOptions(o: Record<string, unknown>): void { clientOptions = o }

/**
 * Octets déjà reçus du fichier, calculés ici plutôt que via `file.downloaded` de WebTorrent : celui-ci retire à tort
 * toute la dernière pièce quand le fichier se termine pile sur une frontière de pièce (progression négative, -1327 %
 * constaté). Pièces vérifiées + part en cours des pièces entamées, toujours bornés à [0, taille du fichier].
 */
export function fileBytesDone(t: Pick<WtTorrent, 'bitfield' | 'pieces' | 'pieceLength' | 'lastPieceLength'>, f: Pick<WtFile, 'offset' | 'length'>): number {
  if (!t.bitfield || f.length <= 0) return 0
  const start = f.offset, end = f.offset + f.length
  let sum = 0
  for (let i = Math.floor(start / t.pieceLength); i <= Math.floor((end - 1) / t.pieceLength) && i < t.pieces.length; i++) {
    const pStart = i * t.pieceLength
    const pLen = i === t.pieces.length - 1 ? t.lastPieceLength : t.pieceLength
    const overlap = Math.min(end, pStart + pLen) - Math.max(start, pStart)
    if (overlap <= 0) continue
    if (t.bitfield.get(i)) sum += overlap
    else { const m = t.pieces[i]?.missing; if (typeof m === 'number' && pLen > 0) sum += overlap * Math.min(1, Math.max(0, 1 - m / pLen)) }
  }
  return Math.min(f.length, Math.max(0, Math.round(sum)))
}

export interface TorrentDownloadOptions {
  /** Lien magnet, ou contenu d'un fichier .torrent déjà récupéré. */
  input: string | Buffer
  /** Dossier de travail (créé ici) : contient les données du torrent, supprimé ou nettoyé par l'appelant. */
  workDir: string
  title: string
  sizeBytes: number | null
  signal: AbortSignal
  onProgress: (done: number, total: number) => void
  metadataTimeoutMs?: number
  stallTimeoutMs?: number
}

/**
 * Télécharge, via le client BitTorrent embarqué, le seul fichier du torrent correspondant à l'entrée (les autres ne
 * sont jamais demandés) et renvoie son chemin absolu dans `workDir`. Ne sème pas après coup. Annulation par `signal`.
 */
export async function downloadTorrent(o: TorrentDownloadOptions): Promise<string> {
  await mkdir(o.workDir, { recursive: true })
  // WebTorrent est ESM seul : import dynamique (Electron/Node ≥ 22), chargé uniquement si une source BitTorrent est utilisée.
  const { default: WebTorrent } = (await import('webtorrent')) as unknown as { default: new (opts: Record<string, unknown>) => WtClient }
  const client = new WebTorrent(clientOptions)
  const metadataTimeout = o.metadataTimeoutMs ?? 120_000
  const stallTimeout = o.stallTimeoutMs ?? 300_000

  const timers: NodeJS.Timeout[] = []
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<string>((resolve, reject) => {
      if (o.signal.aborted) return reject(new Error('annulé'))
      onAbort = (): void => reject(new Error('annulé'))
      o.signal.addEventListener('abort', onAbort, { once: true })
      client.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))

      const torrent = client.add(o.input, { path: o.workDir, deselect: true })
      torrent.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
      o.onProgress(0, 0)

      const metaTimer = setTimeout(() => reject(new Error('métadonnées du torrent introuvables (aucun pair ?)')), metadataTimeout)
      timers.push(metaTimer)

      torrent.on('ready', () => {
        clearTimeout(metaTimer)
        const idx = pickTorrentFile(torrent.files, o.title, o.sizeBytes)
        if (idx === null) return reject(new Error(`torrent de ${torrent.files.length} fichiers : impossible de déterminer lequel correspond à « ${o.title} »`))
        const file = torrent.files[idx]
        file.select()
        let last = 0
        let lastData = Date.now()
        const report = (force: boolean): void => {
          const now = Date.now()
          if (force || now - last > 150) { last = now; o.onProgress(fileBytesDone(torrent, file), file.length) }
        }
        const finish = (): void => { o.onProgress(file.length, file.length); resolve(join(o.workDir, file.path)) }
        if (file.done) return finish()
        torrent.on('download', () => { lastData = Date.now(); report(false) })
        timers.push(setInterval(() => {
          if (Date.now() - lastData > stallTimeout) reject(new Error('téléchargement bloqué (plus aucun pair ne fournit de données)'))
        }, 1000))
        // `done` d'un fichier : pièces vérifiées par SHA-1 par le client lui-même.
        ;(file as unknown as { on(ev: string, cb: () => void): void }).on('done', finish)
      })
    })
  } finally {
    timers.forEach((t) => { clearTimeout(t); clearInterval(t) })
    if (onAbort) o.signal.removeEventListener('abort', onAbort)
    // Attendre la fermeture : sous Windows les fichiers du torrent restent verrouillés tant que le store n'est pas fermé.
    await new Promise<void>((r) => { try { client.destroy(() => r()) } catch { r() } })
  }
}

/** Récupère un fichier .torrent via le même `fetch` que les téléchargements HTTP (petit : plafonné à 10 Mo). */
export async function fetchTorrentFile(
  uri: string, signal: AbortSignal,
  httpFetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>
): Promise<Buffer> {
  const res = await httpFetch(uri, { headers: { 'user-agent': 'RomVault' }, signal })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0 || buf.length > 10 * 1024 * 1024) throw new Error('fichier .torrent invalide')
  return buf
}
