import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseSelectOnly, planTorrent } from './torrentPlan'
import { wuaPrecheck } from './precheck'

/**
 * Support BitTorrent du téléchargeur (client WebTorrent embarqué, MIT, aucun logiciel externe). RomVault ne fournit
 * ni magnet, ni tracker, ni .torrent : seules les URI des listes ajoutées par l'utilisateur sont utilisées, et seuls
 * les trackers/pairs qu'elles portent (le DHT public fait partie du protocole, pas d'une source fournie par RomVault).
 */

export { uriKind, type UriKind } from '@shared/uriKind'

export { pickTorrentFile, planTorrent, type TorrentFileInfo, type TorrentPlan } from './torrentPlan'

// Types minimaux de la partie de l'API WebTorrent utilisée (le paquet n'embarque pas de .d.ts).
interface WtFile { name: string; path: string; length: number; offset: number; done: boolean; select(): void; createReadStream(opts: { start: number; end: number }): AsyncIterable<Buffer> & { destroy(): void } }
interface WtTorrent {
  destroyed?: boolean
  files: WtFile[]
  bitfield: { get(i: number): boolean } | null
  pieces: ({ missing: number } | null)[]
  pieceLength: number
  lastPieceLength: number
  on(ev: string, cb: (...a: unknown[]) => void): void
  destroy(opts: { destroyStore: boolean }, cb: (err?: unknown) => void): void
}
interface WtDht {
  toJSON(): { nodes: { host: string; port: number }[] }
  addNode(node: { host: string; port: number }): void
}
interface WtClient {
  add(id: string | Buffer, opts: { path: string; deselect: boolean }): WtTorrent
  on(ev: string, cb: (e: unknown) => void): void
  off(ev: string, cb: (e: unknown) => void): void
  destroy(cb: (err?: unknown) => void): void
  dht?: WtDht | false | null
  destroyed?: boolean
}

// Réglages du client : davantage de connexions par torrent que les 55 par défaut ; TCP seul (pas d'uTP) : WebTorrent tente d'abord CHAQUE pair IPv4 en uTP et ne passe au TCP
// qu'après plusieurs essais espacés — constaté ici : 110 connexions uTP sur 121 en « connect timeout », seulement 1 à 3 pairs actifs après 60 s, contre 2 à 6 en TCP seul
// (33 Mo reçus en 90 s contre 3,5 ; 8 contre 6 sur un second essai). DHT, échange de pairs et découverte locale restent ceux de WebTorrent. Aucun tracker ni pair n'est ajouté ici : seuls ceux du lien/du .torrent de l'utilisateur et le DHT public du protocole servent.
const DEFAULT_CLIENT_OPTIONS: Record<string, unknown> = { maxConns: 100, utp: false }
let clientOptions: Record<string, unknown> = DEFAULT_CLIENT_OPTIONS
/** Tests seulement : options du client (pas de DHT, de tracker ni d'UPnP publics). Le client partagé en cours est abandonné pour que les nouvelles options s'appliquent. */
export function setTorrentClientOptions(o: Record<string, unknown>): void { clientOptions = o; void dropClient() }

/**
 * Client partagé : un seul pour tous les téléchargements en cours, gardé un court instant après le dernier. Sa table DHT (les nœuds déjà rencontrés) sert alors tout de suite
 * au téléchargement suivant au lieu de repartir de zéro, et les nœuds sont mémorisés sur disque pour le prochain lancement de l'application. Sans torrent actif, il ne
 * partage rien (pas de semis après coup) ; il est détruit après `IDLE_MS` d'inactivité.
 */
const IDLE_MS = 60_000
const MAX_SAVED_NODES = 300
interface Shared { client: WtClient; users: number; idle: NodeJS.Timeout | null; cacheFile: string | null; /** Client à part (un torrent déjà en cours dans le client partagé) : détruit dès que son téléchargement s'achève. */ exclusive?: boolean }
/**
 * Un même torrent (infohash) ne peut être qu'une fois dans un client : une collection (« Minerva », « switch games »…) sert des centaines de jeux depuis UN torrent, chacun
 * téléchargé avec sa sélection de fichiers. Le second téléchargement simultané du même torrent a donc son propre client (le premier reste dans le client partagé) ;
 * sinon `client.add` échoue (« Cannot add duplicate torrent ») sur le client, ce qui abattait aussi le téléchargement déjà en cours.
 */
const activeKeys = new Map<string, number>()
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32ToHex(s: string): string {
  let bits = ''
  for (const ch of s.toUpperCase()) bits += BASE32.indexOf(ch).toString(2).padStart(5, '0')
  let hex = ''
  for (let i = 0; i + 4 <= bits.length && hex.length < 40; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}
/** Identité d'un torrent : infohash d'un magnet, empreinte du contenu d'un .torrent ; null si elle ne peut pas être lue. */
export function torrentKey(input: string | Buffer): string | null {
  if (typeof input !== 'string') return createHash('sha1').update(input).digest('hex')
  const m = /[?&]xt=urn:btih:([0-9a-f]{40}|[a-z2-7]{32})(?=&|$)/i.exec(input)
  if (!m) return null
  return m[1].length === 40 ? m[1].toLowerCase() : base32ToHex(m[1])
}
let shared: Shared | null = null
let sharedPending: Promise<Shared> | null = null

async function loadDhtNodes(file: string): Promise<{ host: string; port: number }[]> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter((n): n is { host: string; port: number } => !!n && typeof (n as { host?: unknown }).host === 'string' && Number.isInteger((n as { port?: unknown }).port)).slice(0, MAX_SAVED_NODES)
  } catch { return [] }
}

async function saveDhtNodes(client: WtClient, file: string | null): Promise<void> {
  if (!file || !client.dht) return
  try {
    const nodes = client.dht.toJSON().nodes.slice(0, MAX_SAVED_NODES)
    if (nodes.length === 0) return
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(nodes))
  } catch { /* simple accélérateur : un échec d'écriture ne gêne jamais le téléchargement */ }
}

async function dropClient(): Promise<void> {
  const cur = shared ?? (sharedPending ? await sharedPending.catch(() => null) : null)
  shared = null
  sharedPending = null
  if (!cur) return
  if (cur.idle) clearTimeout(cur.idle)
  await saveDhtNodes(cur.client, cur.cacheFile)
  await new Promise<void>((r) => { try { cur.client.destroy(() => r()) } catch { r() } })
}

/**
 * Routeurs d'amorçage du DHT public (ceux de k-rpc, plus celui de libtorrent), RÉSOLUS ICI en adresses IPv4. Le DHT de WebTorrent les reçoit par nom d'hôte et, constaté sur
 * Windows (Node 22) : la réponse d'un routeur vient d'une adresse IP, la requête est restée associée à son nom, la réponse est ignorée et la table reste VIDE — aucun pair ne
 * serait trouvé par le DHT, seuls les trackers serviraient (0 nœud en 6 s par nom ; avec les adresses : 42 nœuds et 40 pairs pour le torrent testé).
 */
const DHT_ROUTERS: readonly (readonly [string, number])[] = [['router.bittorrent.com', 6881], ['router.utorrent.com', 6881], ['dht.transmissionbt.com', 6881], ['dht.libtorrent.org', 25401]]
let bootstrapCache: string[] | null = null
async function dhtBootstrap(): Promise<string[]> {
  if (bootstrapCache?.length) return bootstrapCache
  const out: string[] = []
  await Promise.all(DHT_ROUTERS.map(async ([host, port]) => {
    try {
      const found = await Promise.race([lookup(host, { family: 4, all: true }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns')), 4000).unref?.())])
      for (const a of found) out.push(`${a.address}:${port}`)
    } catch { /* routeur injoignable : les autres suffisent */ }
  }))
  bootstrapCache = out
  return out
}

async function createClient(cacheFile: string | null): Promise<WtClient> {
  // WebTorrent est ESM seul : import dynamique (Electron/Node ≥ 22), chargé uniquement si une source BitTorrent est utilisée.
  const { default: WebTorrent } = (await import('webtorrent')) as unknown as { default: new (opts: Record<string, unknown>) => WtClient }
  const opts = { ...clientOptions }
  if (opts['dht'] !== false && opts['dht'] === undefined) { const bootstrap = await dhtBootstrap(); if (bootstrap.length) opts['dht'] = { bootstrap } }
  const client = new WebTorrent(opts)
  // Nœuds DHT de la session précédente : pingués, seuls ceux qui répondent entrent dans la table.
  if (cacheFile && client.dht) for (const n of await loadDhtNodes(cacheFile)) { try { client.dht.addNode(n) } catch { /* nœud inutilisable : ignoré */ } }
  return client
}

async function acquireClient(cacheFile: string | null, exclusive = false): Promise<Shared> {
  if (exclusive) return { client: await createClient(cacheFile), users: 1, idle: null, cacheFile, exclusive: true }
  if (shared && !shared.client.destroyed) { if (shared.idle) { clearTimeout(shared.idle); shared.idle = null } shared.users++; return shared }
  if (!sharedPending) {
    sharedPending = (async () => {
      const entry: Shared = { client: await createClient(cacheFile), users: 0, idle: null, cacheFile }
      shared = entry
      return entry
    })().finally(() => { sharedPending = null })
  }
  const entry = await sharedPending
  if (entry.client.destroyed) { shared = null; return acquireClient(cacheFile) }
  entry.users++
  return entry
}

function releaseClient(entry: Shared): void {
  if (entry.exclusive) {
    void saveDhtNodes(entry.client, entry.cacheFile).then(() => new Promise<void>((r) => { try { entry.client.destroy(() => r()) } catch { r() } }))
    return
  }
  entry.users = Math.max(0, entry.users - 1)
  if (entry.users > 0 || shared !== entry) return
  void saveDhtNodes(entry.client, entry.cacheFile)
  entry.idle = setTimeout(() => { if (shared === entry && entry.users === 0) void dropClient() }, IDLE_MS)
  entry.idle.unref?.()
}

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
  /** Console de l'entrée : décide quels fichiers un torrent multi-fichiers doit fournir (voir `planTorrent`). Absente = un seul fichier, choisi par titre/taille. */
  consoleId?: string | null
  signal: AbortSignal
  onProgress: (done: number, total: number) => void
  metadataTimeoutMs?: number
  stallTimeoutMs?: number
  /** Délai sans le moindre octet reçu depuis le début avant de conclure que personne ne partage ce torrent (défaut 120 s). */
  noPeerTimeoutMs?: number
  /** Fichier où mémoriser les nœuds DHT rencontrés (démarrage plus rapide la fois suivante). */
  dhtCacheFile?: string
}

/**
 * Télécharge, via le client BitTorrent embarqué, les seuls fichiers du torrent dont l'entrée a besoin (voir `planTorrent` : le jeu, les pistes de son disque, ses
 * mises à jour et DLC… jamais le reste, qui n'est même pas demandé) et renvoie leurs chemins absolus dans `workDir`, le fichier principal en premier. Ne sème pas
 * après coup. Annulation par `signal`.
 */
export async function downloadTorrent(o: TorrentDownloadOptions): Promise<string[]> {
  await mkdir(o.workDir, { recursive: true })
  const key = torrentKey(o.input)
  const dup = key !== null && (activeKeys.get(key) ?? 0) > 0
  if (key !== null) activeKeys.set(key, (activeKeys.get(key) ?? 0) + 1)
  let entry: Shared
  try { entry = await acquireClient(o.dhtCacheFile ?? null, dup) } catch (e) { if (key !== null) activeKeys.set(key, (activeKeys.get(key) ?? 1) - 1); throw e }
  const client = entry.client
  let current: WtTorrent | null = null
  let onClientError: ((e: unknown) => void) | undefined
  const metadataTimeout = o.metadataTimeoutMs ?? 120_000
  const stallTimeout = o.stallTimeoutMs ?? 300_000
  const noPeerTimeout = o.noPeerTimeoutMs ?? 120_000

  const timers: NodeJS.Timeout[] = []
  let onAbort: (() => void) | undefined
  try {
    if (o.signal.aborted) throw new Error('annulé')
    const added = client.add(o.input, { path: o.workDir, deselect: true })
    current = added
    return await new Promise<string[]>((resolve, reject) => {
      if (o.signal.aborted) return reject(new Error('annulé'))
      onAbort = (): void => reject(new Error('annulé'))
      o.signal.addEventListener('abort', onAbort, { once: true })
      onClientError = (e: unknown): void => {
        // Un ajout en double (autre téléchargement du même torrent, forme d'identifiant différente) n'abat pas ce téléchargement-ci.
        if (/Cannot add duplicate torrent/.test(String(e))) return
        if (!entry.exclusive) void dropClient()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
      client.on('error', onClientError)

      const torrent = added
      torrent.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
      o.onProgress(0, 0)

      const metaTimer = setTimeout(() => reject(new Error('métadonnées du torrent introuvables (aucun pair ?)')), metadataTimeout)
      timers.push(metaTimer)

      torrent.on('ready', () => {
        clearTimeout(metaTimer)
        let plan: ReturnType<typeof planTorrent>
        try { plan = planTorrent(torrent.files.map((f) => ({ name: f.name, path: f.path, length: f.length })), o.title, o.sizeBytes, o.consoleId ?? null, parseSelectOnly(o.input)) } catch (e) { return reject(e instanceof Error ? e : new Error(String(e))) }
        if (!plan) return reject(new Error(`torrent de ${torrent.files.length} fichiers : impossible de déterminer lequel correspond à « ${o.title} »`))
        const primary = plan.primary
        const selected: number[] = []
        let followed = !plan.followUp
        let finished = false
        let last = 0
        const startedAt = Date.now()
        let lastData = startedAt
        let gotData = false
        const report = (force: boolean): void => {
          const now = Date.now()
          if (!force && now - last <= 150) return
          last = now
          o.onProgress(selected.reduce((n, i) => n + fileBytesDone(torrent, torrent.files[i]), 0), selected.reduce((n, i) => n + torrent.files[i].length, 0))
        }
        // Fichier ajouté à la sélection (jamais deux fois) : sa fin est surveillée par `check`.
        const select = (i: number): void => {
          if (selected.includes(i) || i < 0 || i >= torrent.files.length) return
          selected.push(i)
          const f = torrent.files[i]
          f.select()
          ;(f as unknown as { on(ev: string, cb: () => void): void }).on('done', check)
        }
        const check = (): void => {
          if (finished) return
          report(true)
          if (!torrent.files[primary].done) return
          if (!followed) {
            followed = true
            // Le fichier principal est là : on lit ce qu'il dit (pistes d'un .cue, jeu de ses mises à jour…) pour savoir quoi demander ensuite.
            void plan!.followUp!(join(o.workDir, torrent.files[primary].path)).then((more) => { more.forEach(select); report(true); check() }, (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))))
            return
          }
          if (selected.every((i) => torrent.files[i].done)) {
            finished = true
            resolve([primary, ...selected.filter((i) => i !== primary)].map((i) => join(o.workDir, torrent.files[i].path)))
          }
        }
        timers.push(setInterval(() => {
          if (!gotData && Date.now() - startedAt > noPeerTimeout) reject(new Error('aucun pair ne partage ce torrent (source morte ?)'))
          else if (Date.now() - lastData > stallTimeout) reject(new Error('téléchargement bloqué (plus aucun pair ne fournit de données)'))
        }, 1000))
        torrent.on('download', () => { lastData = Date.now(); gotData = true; report(false) })
        const begin = (): void => {
          if (o.signal.aborted || torrent.destroyed) return
          select(primary)
          plan!.extras.forEach(select)
          report(true)
          check() // reprise d'un dossier de travail déjà complet
        }
        // Wii U : un .wua dont l'intérieur est un titre Wii (vWii) ne sert à rien dans Cemu ; sa fin (noms, arborescence) suffit à le savoir : on ne télécharge ce jeu que s'il est valide.
        const pf = torrent.files[primary]
        if (o.consoleId === 'wiiu' && /\.wua$/i.test(pf.name) && pf.length > 144) {
          const readRange = async (start: number, length: number): Promise<Buffer> => {
            const stream = pf.createReadStream({ start, end: start + length - 1 })
            const chunks: Buffer[] = []
            try { for await (const c of stream) chunks.push(c) } finally { stream.destroy() }
            return Buffer.concat(chunks)
          }
          void wuaPrecheck(readRange, pf.length).then((bad) => { if (bad) reject(new Error(bad)); else begin() })
        } else begin()
      })
    })
  } finally {
    timers.forEach((t) => { clearTimeout(t); clearInterval(t) })
    if (onAbort) o.signal.removeEventListener('abort', onAbort)
    if (onClientError) client.off('error', onClientError)
    // Ce torrent seul est retiré du client partagé, et on attend la fermeture de son stockage : sous Windows les fichiers restent verrouillés tant qu'il n'est pas fermé.
    if (key !== null) { const n = (activeKeys.get(key) ?? 1) - 1; if (n > 0) activeKeys.set(key, n); else activeKeys.delete(key) }
    if (current) {
      const t = current as WtTorrent
      // Borné : la fonction de rappel de `destroy` ne revient jamais pour un torrent déjà détruit.
      await new Promise<void>((r) => { const to = setTimeout(r, 15_000); try { t.destroy({ destroyStore: false }, () => { clearTimeout(to); r() }) } catch { clearTimeout(to); r() } })
    }
    releaseClient(entry)
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
