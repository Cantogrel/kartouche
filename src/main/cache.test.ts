import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppPaths } from '@shared/ipc'
import { cacheSize, clearCache } from './cache'

let dir: string
let paths: AppPaths
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rv-cache-'))
  paths = { dataDir: dir, roms: join(dir, 'roms'), emulators: join(dir, 'emulators'), bios: join(dir, 'bios'), saves: join(dir, 'saves'), cache: join(dir, 'cache'), dats: join(dir, 'dats'), logs: join(dir, 'logs') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function put(relPath: string, content = 'x'): Promise<string> {
  const p = join(paths.cache, relPath)
  await mkdir(join(p, '..'), { recursive: true })
  await writeFile(p, content)
  return p
}

describe('clearCache', () => {
  it('vide les téléchargements de jeux, les archives d’émulateurs et les fichiers temporaires, mais garde les images du catalogue', async () => {
    await put('game-downloads/42/Jeu.zip', 'abcd')
    await put('downloads/retroarch.zip', 'abcde')
    await put('tools/quit-watch.ps1', 'abc')
    const img = await put('images/card/1.img', 'une image')

    const result = await clearCache(paths, {})

    expect(result.freedBytes).toBe(4 + 5 + 3)
    expect(result.skippedSourceIds).toEqual([])
    expect(result.skippedTools).toBe(false)
    expect(existsSync(join(paths.cache, 'game-downloads', '42'))).toBe(false) // le sous-dossier par source est retiré…
    expect(existsSync(join(paths.cache, 'game-downloads'))).toBe(true) // …mais le dossier parent reste (recréé à chaque téléchargement de toute façon)
    expect(existsSync(join(paths.cache, 'downloads'))).toBe(false)
    expect(existsSync(join(paths.cache, 'tools'))).toBe(false)
    expect(existsSync(img)).toBe(true) // fiches/images du catalogue : jamais vidées (coûteuses à regénérer sous quota API)
  })

  it('laisse de côté le dossier d’un téléchargement en cours', async () => {
    await put('game-downloads/1/encours.zip.part', 'abc')
    await put('game-downloads/2/termine.zip', 'abcd')

    const result = await clearCache(paths, { busySourceIds: new Set([1]) })

    expect(result.skippedSourceIds).toEqual([1])
    expect(existsSync(join(paths.cache, 'game-downloads', '1'))).toBe(true)
    expect(existsSync(join(paths.cache, 'game-downloads', '2'))).toBe(false)
  })

  it('laisse cache/downloads de côté pendant une installation d’émulateur', async () => {
    await put('downloads/en-cours.zip', 'abc')

    const result = await clearCache(paths, { emulatorInstalling: true })

    expect(result.freedBytes).toBe(0)
    expect(existsSync(join(paths.cache, 'downloads'))).toBe(true)
  })

  it('laisse cache/tools de côté (scripts + ROM extraite) tant qu’une partie tourne', async () => {
    await put('tools/extracted-rom/Jeu.gbc', 'abc')

    const result = await clearCache(paths, { gameRunning: true })

    expect(result.skippedTools).toBe(true)
    expect(existsSync(join(paths.cache, 'tools'))).toBe(true)
  })

  it('ne plante pas si le cache est déjà vide ou inexistant', async () => {
    const result = await clearCache(paths, {})
    expect(result).toEqual({ freedBytes: 0, skippedTools: false, skippedSourceIds: [] })
  })
})

describe('cacheSize', () => {
  it("additionne game-downloads, downloads et tools, mais pas images", async () => {
    await put('game-downloads/42/Jeu.zip', 'abcd')
    await put('downloads/retroarch.zip', 'abcde')
    await put('tools/quit-watch.ps1', 'abc')
    await put('images/card/1.img', 'une image bien plus grande que le reste')

    expect(await cacheSize(paths)).toBe(4 + 5 + 3)
  })

  it('renvoie 0 si le cache est vide ou inexistant', async () => {
    expect(await cacheSize(paths)).toBe(0)
  })
})
