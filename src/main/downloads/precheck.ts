import type { HttpFetch } from './engine'
import { isVWiiWrapper, readWuaFilesFrom, VWII_REASON, type RangeReader } from '../library/content/wua'

/**
 * Avant de télécharger un .wua Wii U (plusieurs Go) : un titre Wii (vWii) emballé pour Wii U ne s'exécute pas dans Cemu (voir `isVWiiWrapper`). Le pied de page, les noms et l'arborescence
 * d'une archive ZArchive sont à la FIN du fichier et non compressés : on ne lit que ces quelques octets (requêtes « Range » HTTP, ou pièces de fin d'un torrent) et le téléchargement
 * n'a pas lieu si l'archive est de ce type. Sans réponse exploitable (serveur sans « Range », lecture impossible), on ne bloque rien : l'import refusera de toute façon le fichier.
 */
export async function wuaPrecheck(read: RangeReader, size: number): Promise<string | null> {
  try {
    const files = await readWuaFilesFrom(read, size)
    return files && isVWiiWrapper(files) ? VWII_REASON : null
  } catch { return null }
}

const WUA_URL = /\.wua(?:[?#]|$)/i

/** Problème connu d'un .wua distant (HTTP) avant téléchargement, ou null. */
export async function remoteWuaProblem(uri: string, signal: AbortSignal, httpFetch: HttpFetch): Promise<string | null> {
  if (!WUA_URL.test(uri)) return null
  const range = async (spec: string): Promise<Response | null> => {
    const res = await httpFetch(uri, { headers: { 'user-agent': 'Kartouche', range: spec }, signal }).catch(() => null)
    if (res && res.status !== 206) { await res.body?.cancel().catch(() => undefined); return null }
    return res
  }
  try {
    const probe = await range('bytes=0-0')
    const total = Number(/\/(\d+)\s*$/.exec(probe?.headers.get('content-range') ?? '')?.[1] ?? 0)
    await probe?.body?.cancel().catch(() => undefined)
    if (!total) return null
    const read: RangeReader = async (start, length) => {
      const res = await range(`bytes=${start}-${start + length - 1}`)
      if (!res) throw new Error('plage non prise en charge')
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length !== length) throw new Error('plage incomplète')
      return buf
    }
    return await wuaPrecheck(read, total)
  } catch { return null }
}
