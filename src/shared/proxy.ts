/** Proxy RomVault (server/ du dépôt) : il détient les clés IGDB / TheGamesDB / SteamGridDB, l'app n'en contient aucune. */
export const PROXY_URL = 'https://romvault.binaweb.fr'
/** Valeur de réglage signifiant « passer par le proxy » (l'utilisateur n'a pas mis sa propre clé). */
export const PROXY_KEY = 'rv-proxy'
/** Filtre anti-curieux côté serveur, pas un secret. */
export const PROXY_TOKEN = 'rv-app-9f3c1d'
export const PROXY_HEADERS = { 'X-RV-Token': PROXY_TOKEN }
