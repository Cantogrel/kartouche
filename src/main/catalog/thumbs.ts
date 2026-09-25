import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { consoleById } from '@shared/consoles'
import { thumbnailUrl } from './libretro'

const MISS_TTL_MS = 7 * 24 * 3600 * 1000
const safe = (s: string): string => s.replace(/[<>:"/\|?*\x00-\x1f]/g, '_')

/** Image du jeu depuis le cache disque, sinon téléchargée sur thumbnails.libretro.com (boîtier, puis écran-titre). null si introuvable. */
export async function getThumbnail(cacheDir: string, consoleId: string, title: string): Promise<Buffer | null> {
  const def = consoleById(consoleId)
  if (!def) return null
  const dir = join(cacheDir, 'thumbs', consoleId)
  const file = join(dir, `${safe(title)}.png`)
  try { return await readFile(file) } catch { /* pas en cache */ }
  const miss = `${file}.miss`
  try { if (Date.now() - (await stat(miss)).mtimeMs < MISS_TTL_MS) return null } catch { /* pas de marqueur */ }
  await mkdir(dir, { recursive: true })
  for (const kind of ['Named_Boxarts', 'Named_Titles'] as const) {
    try {
      const res = await fetch(thumbnailUrl(def, title, kind), { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      await writeFile(file, buf)
      return buf
    } catch { return null } // réseau indisponible : ne pas poser de marqueur d'absence
  }
  await writeFile(miss, '')
  return null
}
