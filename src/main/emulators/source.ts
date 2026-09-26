import type { EmulatorDef } from '@shared/emulators'

export interface Release { version: string; url: string; name: string }

interface ApiAsset { name: string; browser_download_url: string }
interface ApiRelease { tag_name: string; name?: string; draft?: boolean; prerelease?: boolean; published_at?: string; assets: ApiAsset[] }

const HEADERS = { 'user-agent': 'RomVault', accept: 'application/json' }

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

/** Dernière version de l'émulateur pour Windows x64. */
export async function latestRelease(def: EmulatorDef): Promise<Release> {
  const s = def.source
  let rel: Release | null = null
  if (s.kind === 'github') {
    rel = pickRelease(await getJson<ApiRelease[]>(`https://api.github.com/repos/${s.repo}/releases?per_page=10`), s.asset, s.prerelease ?? false)
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
