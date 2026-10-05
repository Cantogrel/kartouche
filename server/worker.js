// Proxy Cloudflare Worker de Kartouche : ajoute les clés IGDB / TheGamesDB / SteamGridDB côté serveur (secrets du Worker),
// l'app n'en contient aucune.
//   POST /igdb            corps Apicalypse -> https://api.igdb.com/v4/games (jeton Twitch mis en cache)
//   GET  /tgdb/<chemin>   -> https://api.thegamesdb.net/<chemin>?apikey=...
//   GET  /sgdb/<chemin>   -> https://www.steamgriddb.com/api/v2/<chemin> (Bearer)
// Secrets : APP_TOKEN, IGDB_CLIENT_ID, IGDB_SECRET, TGDB_KEY, SGDB_KEY (voir server/README.md).

let twitch = null // { value, expires } — gardé tant que l'instance du Worker vit

async function igdbToken(env) {
  if (twitch && twitch.expires > Date.now() + 60_000) return twitch.value
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(env.IGDB_CLIENT_ID)}&client_secret=${encodeURIComponent(env.IGDB_SECRET)}&grant_type=client_credentials`, { method: 'POST' })
  if (!r.ok) throw new Error('twitch auth failed')
  const j = await r.json()
  twitch = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 }
  return twitch.value
}

const text = (status, msg) => new Response(msg, { status, headers: { 'content-type': 'text/plain' } })
const pass = (r) => new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } })

export default {
  async fetch(req, env) {
    if (req.headers.get('x-rv-token') !== env.APP_TOKEN) return text(403, 'forbidden')
    const url = new URL(req.url)
    const m = url.pathname.match(/^\/(igdb|tgdb|sgdb)(\/[^\s?#]*)?$/)
    if (!m || decodeURIComponent(url.pathname).includes('..')) return text(404, 'not found')
    const [, svc, sub = ''] = m
    try {
      if (svc === 'igdb') {
        if (req.method !== 'POST' || sub) return text(405, 'POST /igdb')
        const r = await fetch('https://api.igdb.com/v4/games', { method: 'POST', body: await req.text(), headers: { 'Client-ID': env.IGDB_CLIENT_ID, Authorization: `Bearer ${await igdbToken(env)}` } })
        return pass(r)
      }
      if (req.method !== 'GET') return text(405, 'GET only')
      if (svc === 'tgdb') {
        url.searchParams.set('apikey', env.TGDB_KEY)
        return pass(await fetch(`https://api.thegamesdb.net${sub}${url.search}`))
      }
      url.searchParams.delete('apikey')
      return pass(await fetch(`https://www.steamgriddb.com/api/v2${sub}${url.search}`, { headers: { Authorization: `Bearer ${env.SGDB_KEY}` } }))
    } catch {
      return text(502, 'upstream error')
    }
  }
}
