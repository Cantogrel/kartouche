/*
 * Le lecteur YouTube refuse de démarrer (« Erreur 153 : erreur de configuration du lecteur vidéo ») quand la page qui l'intègre n'indique pas qui elle est :
 * l'interface de Kartouche est un fichier local (file://), donc sans Referer. On en pose un, qui identifie l'application, sur la seule requête du CADRE
 * du lecteur (jamais sur les ressources que le lecteur charge ensuite, ni sur d'autres domaines).
 */

export const EMBED_HOST = 'www.youtube-nocookie.com'
export const EMBED_REFERER = 'https://github.com/Cantogrel/kartouche'

/** Faux sauf pour le chargement du cadre `https://www.youtube-nocookie.com/embed/<id>`. */
export function needsEmbedReferer(url: string, resourceType: string): boolean {
  if (resourceType !== 'subFrame') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === EMBED_HOST && u.pathname.startsWith('/embed/')
  } catch { return false }
}
