import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { download, extract } from './installer'

// RetroArch embarque SDL2 2.0.14 (2021) : trop ancien pour réunir une paire de Joy-Con en une seule manette (cela date de SDL 2.30), il les voit comme deux manettes génériques. On le remplace,
// avant de lancer un jeu avec une paire de Joy-Con, par la version officielle de SDL2 (même ABI, DLL de remplacement directe). Le téléchargement vient des publications officielles de
// libsdl-org et son empreinte SHA-256 est vérifiée (celle publiée par GitHub pour ce fichier) ; l'ancienne DLL est gardée à côté sous « SDL2.dll.kartouche-orig ».
export const SDL2_VERSION = '2.32.10'
export const SDL2_URL = `https://github.com/libsdl-org/SDL/releases/download/release-${SDL2_VERSION}/SDL2-${SDL2_VERSION}-win32-x64.zip`
export const SDL2_SHA256 = '6cf9706eefd0a4a06dc764007934d428afaf029fabdd408a9e646048c91e18fb'

/** Version de SDL2 inscrite dans une DLL (« SDL2-2.0.14 »), ou null si elle n'y est pas. */
export function sdl2VersionIn(content: string): [number, number, number] | null {
  const m = /SDL2?-(\d+)\.(\d+)\.(\d+)/.exec(content)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Vrai si la version sait réunir les Joy-Con (SDL 2.30 et au-delà). */
export const sdl2CanCombineJoyCons = (v: readonly [number, number, number] | null): boolean => v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 30))

/**
 * S'assure que le dossier de l'émulateur contient un SDL2 capable de réunir les Joy-Con. Faux (sans rien casser) si le téléchargement ou la vérification échoue : l'appelant refuse alors la paire.
 * `fetchZip` est injectable pour les tests.
 */
export async function ensureModernSdl2(dir: string, cacheDir: string, fetchZip: (url: string, file: string) => Promise<void> = (u, f) => download(u, f, () => undefined)): Promise<boolean> {
  const dll = join(dir, 'SDL2.dll')
  if (!existsSync(dll)) return false
  if (sdl2CanCombineJoyCons(sdl2VersionIn((await readFile(dll)).toString('latin1')))) return true
  const work = await mkdtemp(join(await mkdir(join(cacheDir, 'downloads'), { recursive: true }).then(() => join(cacheDir, 'downloads')), 'sdl2-'))
  try {
    const zip = join(work, `SDL2-${SDL2_VERSION}.zip`)
    await fetchZip(SDL2_URL, zip)
    const sha = createHash('sha256').update(await readFile(zip)).digest('hex')
    if (sha !== SDL2_SHA256) return false
    const out = join(work, 'x')
    await mkdir(out, { recursive: true })
    await extract(zip, out)
    const fresh = join(out, 'SDL2.dll')
    if (!existsSync(fresh) || !sdl2CanCombineJoyCons(sdl2VersionIn((await readFile(fresh)).toString('latin1')))) return false
    const orig = `${dll}.kartouche-orig`
    if (!existsSync(orig)) await rename(dll, orig)
    else await rm(dll, { force: true })
    await copyFile(fresh, dll)
    return true
  } catch {
    return false
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}
