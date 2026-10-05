import type { EmulatorDef } from '@shared/emulators'

export interface Release { version: string; url: string; name: string }

interface ApiAsset { name: string; browser_download_url: string }
interface ApiRelease { tag_name: string; name?: string; draft?: boolean; prerelease?: boolean; published_at?: string; assets: ApiAsset[] }

const HEADERS = { 'user-agent': 'Kartouche', accept: 'application/json' }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return (await res.json()) as T
}

/** Première version publiée (les plus récentes d'abord) qui contient un fichier au nom voulu. */
export function pickRelease(releases: ApiRelease[], asset: string, prerelease: boolean): Release | null {
  const re = new RegExp(asset)
  for (const r of releases) {
    if (r.draft || (r.prerelease && !prerelease)) continue
    const a = r.assets.find((x) => re.test(x.name))
    // Étiquettes glissantes (« latest », « continuous ») : la date de publication sert de version.
    if (a) return { version: /^v?\d/.test(r.tag_name) ? r.tag_name : (r.published_at ?? r.tag_name).slice(0, 10), url: a.browser_download_url, name: a.name }
  }
  return null
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'Kartouche' }, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

/** Tags (les plus récents d'abord) et dates d'un flux atom de releases GitHub. */
export function parseReleasesAtom(xml: string): { tag: string; date: string }[] {
  const out: { tag: string; date: string }[] = []
  for (const entry of xml.split('<entry>').slice(1)) {
    const tag = /href="[^"]*\/releases\/tag\/([^"]+)"/.exec(entry)?.[1]
    const date = /<updated>([^<]+)<\/updated>/.exec(entry)?.[1]
    if (tag && date) out.push({ tag: decodeURIComponent(tag), date })
  }
  return out
}

/** Noms de fichiers d'une page « expanded_assets » de release GitHub : [nom, url]. */
export function parseExpandedAssets(html: string, repo: string, tag: string): [string, string][] {
  const prefix = `/${repo}/releases/download/${encodeURIComponent(tag)}/`
  const out: [string, string][] = []
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const h = m[1].replace(/&amp;/g, '&')
    const i = h.indexOf(prefix)
    if (i === 0 || (i < 0 && h.startsWith(`/${repo}/releases/download/${tag}/`))) out.push([decodeURIComponent(h.split('/').pop() ?? ''), `https://github.com${h}`])
  }
  return out
}

/**
 * Repli quand l'API GitHub refuse (403 : quota de 60 requêtes/heure par adresse IP, vite épuisé — partagé avec tout ce qui
 * tourne derrière la même box). Le flux atom et les pages d'assets ne sont pas soumis à ce quota ; le flux ne distingue pas
 * les préversions, d'où l'usage en secours seulement.
 */
async function githubFallback(repo: string, asset: string): Promise<Release | null> {
  const re = new RegExp(asset)
  const tags = parseReleasesAtom(await getText(`https://github.com/${repo}/releases.atom`)).slice(0, 8)
  for (const { tag, date } of tags) {
    const a = parseExpandedAssets(await getText(`https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`), repo, tag).find(([name]) => re.test(name))
    if (a) return { version: /^v?\d/.test(tag) ? tag : date.slice(0, 10), url: a[1], name: a[0] }
  }
  return null
}

/** Dernière version de l'émulateur pour Windows x64. */
export async function latestRelease(def: EmulatorDef): Promise<Release> {
  const s = def.source
  let rel: Release | null = null
  if (s.kind === 'github') {
    try {
      rel = pickRelease(await getJson<ApiRelease[]>(`https://api.github.com/repos/${s.repo}/releases?per_page=10`), s.asset, s.prerelease ?? false)
    } catch (e) {
      if (!/HTTP (403|429)/.test(String(e))) throw e
      rel = await githubFallback(s.repo, s.asset)
    }
  } else if (s.kind === 'forgejo') {
    rel = pickRelease(await getJson<ApiRelease[]>(s.api), s.asset, false)
  } else if (s.kind === 'rpcs3') {
    const j = await getJson<{ latest_build?: { version: string; windows?: { download: string } } }>('https://update.rpcs3.net/?api=v2&c=RomVault')
    const w = j.latest_build?.windows?.download
    if (w) rel = { version: j.latest_build!.version, url: w, name: w.split('/').pop() ?? 'rpcs3.7z' }
  } else if (s.kind === 'dolphin') {
    const j = await getJson<{ shortrev: string; artifacts: { system: string; url: string }[] }>('https://dolphin-emu.org/update/latest/beta')
    const a = j.artifacts.find((x) => x.system === 'Windows x64')
    if (a) rel = { version: j.shortrev, url: a.url, name: a.url.split('/').pop() ?? 'dolphin.7z' }
  } else {
    const html = await (await fetch('https://buildbot.libretro.com/stable/', { headers: HEADERS, signal: AbortSignal.timeout(20000) })).text()
    const v = retroarchVersion(html)
    if (v) rel = { version: v, url: `https://buildbot.libretro.com/stable/${v}/windows/x86_64/RetroArch.7z`, name: 'RetroArch.7z' }
  }
  if (!rel) throw new Error(`Aucun fichier Windows x64 trouvé pour ${def.name}`)
  return rel
}

/** Plus haute version stable listée dans l'index de buildbot.libretro.com/stable/. */
export function retroarchVersion(html: string): string | null {
  const vs = [...html.matchAll(/href="\/stable\/(\d+(?:\.\d+)+)\/"/g)].map((m) => m[1])
  vs.sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d }
    return 0
  })
  return vs.at(-1) ?? null
}

/** Cœur RetroArch (dernière version « nightly » : la seule que buildbot tient à jour pour chaque cœur). */
export const coreUrl = (core: string): string => `https://buildbot.libretro.com/nightly/windows/x86_64/latest/${core}_libretro.dll.zip`
