export type UriKind = 'http' | 'magnet' | 'torrent'

/** Détecte le mécanisme à utiliser pour une URI de source : `magnet:` → BitTorrent, URL `….torrent` → fichier torrent à récupérer, sinon HTTP (comportement historique). */
export function uriKind(uri: string): UriKind {
  if (/^magnet:/i.test(uri)) return 'magnet'
  try {
    const u = new URL(uri)
    if (/^https?:$/.test(u.protocol) && u.pathname.toLowerCase().endsWith('.torrent')) return 'torrent'
  } catch { /* URI invalide : le chemin HTTP la rejettera comme avant */ }
  return 'http'
}

/** Le téléchargement de cette source passe-t-il par BitTorrent (première URI, la première essayée) ? Sert au tag affiché dans l'UI. */
export const isTorrentSource = (uris: string[]): boolean => !!uris[0] && uriKind(uris[0]) !== 'http'
