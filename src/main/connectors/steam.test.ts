import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseVdf } from './vdf'
import { gameFromManifest, realSteamDeps, steamConnector, type SteamDeps } from './steam'

const acf = (o: { appid: string; name: string; installdir?: string; flags?: number }): string =>
  `"AppState"\n{\n\t"appid"\t\t"${o.appid}"\n\t"LastOwner"\t\t"76561198000000000"\n\t"name"\t\t"${o.name}"\n\t"StateFlags"\t\t"${o.flags ?? 4}"\n${o.installdir ? `\t"installdir"\t\t"${o.installdir}"\n` : ''}}\n`

const LIBS = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Steam"\n\t\t"apps"\n\t\t{\n\t\t\t"10"\t\t"1"\n\t\t}\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\Jeux\\\\SteamLibrary"\n\t}\n}\n`

function fakeSteam(files: Record<string, string>, dir: string | null = 'C:\\Steam'): SteamDeps {
  const norm = (p: string): string => p.replace(/\//g, '\\').toLowerCase()
  const table = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]))
  return {
    steamDir: async () => dir,
    readText: async (p) => table.get(norm(p)) ?? null,
    listDir: async (p) => [...table.keys()].filter((k) => k.startsWith(norm(p) + '\\') && !k.slice(norm(p).length + 1).includes('\\')).map((k) => k.slice(norm(p).length + 1)),
    exists: (p) => table.has(norm(p))
  }
}

describe('parseVdf', () => {
  it('lit blocs, chaînes avec échappements et commentaires', () => {
    const v = parseVdf('// c\n"a" { "b" "x\\\\y" "c" { "d" "1" } }')
    expect(v).toEqual({ a: { b: 'x\\y', c: { d: '1' } } })
  })
  it('ne plante pas sur un fichier tronqué ou illisible', () => {
    expect(parseVdf('"a" { "b" "1"')).toEqual({ a: { b: '1' } })
    expect(parseVdf('{{{ }}} "x"')).toBeTypeOf('object')
    expect(parseVdf('')).toEqual({})
  })
})

describe('gameFromManifest', () => {
  it('décrit un jeu installé : appid, nom, dossier, lancement par Steam', () => {
    expect(gameFromManifest(acf({ appid: '264710', name: 'Subnautica', installdir: 'Subnautica' }), 'C:\\Steam\\steamapps')).toEqual({
      nativeId: '264710', title: 'Subnautica', uri: 'steam://rungameid/264710', installDir: join('C:\\Steam\\steamapps', 'common', 'Subnautica')
    })
  })
  it('écarte outils, redistribuables, jeux pas entièrement installés et manifestes invalides', () => {
    expect(gameFromManifest(acf({ appid: '228980', name: 'Steamworks Common Redistributables' }), 'x')).toBeNull()
    expect(gameFromManifest(acf({ appid: '1493710', name: 'Proton Experimental' }), 'x')).toBeNull()
    expect(gameFromManifest(acf({ appid: '1628350', name: 'Steam Linux Runtime 3.0 (sniper)' }), 'x')).toBeNull()
    expect(gameFromManifest(acf({ appid: '5', name: 'En téléchargement', flags: 1026 }), 'x')).toBeNull()
    expect(gameFromManifest(acf({ appid: 'abc', name: 'Faux id' }), 'x')).toBeNull()
    expect(gameFromManifest('n’importe quoi', 'x')).toBeNull()
  })
  it('ne reprend aucune donnée du compte (propriétaire du jeu)', () => {
    expect(JSON.stringify(gameFromManifest(acf({ appid: '1', name: 'A' }), 'x'))).not.toContain('7656119')
  })
})

describe('steamConnector', () => {
  it('lit la bibliothèque principale et les disques supplémentaires', async () => {
    const c = steamConnector(fakeSteam({
      'C:\\Steam\\steamapps\\libraryfolders.vdf': LIBS,
      'C:\\Steam\\steamapps\\appmanifest_10.acf': acf({ appid: '10', name: 'Jeu A', installdir: 'A' }),
      'C:\\Steam\\steamapps\\appmanifest_228980.acf': acf({ appid: '228980', name: 'Steamworks Common Redistributables' }),
      'D:\\Jeux\\SteamLibrary\\steamapps\\appmanifest_20.acf': acf({ appid: '20', name: 'Jeu B', installdir: 'B' }),
      'C:\\Steam\\steamapps\\notes.txt': 'x'
    }))
    expect(await c.detect()).toBe(true)
    const games = (await c.scan()) as { nativeId: string; installDir: string }[]
    expect(games.map((g) => g.nativeId).sort()).toEqual(['10', '20'])
    expect(games.find((g) => g.nativeId === '20')!.installDir.toLowerCase()).toContain('d:\\jeux\\steamlibrary\\steamapps\\common\\b')
  })
  it('ne compte pas deux fois une bibliothèque déclarée deux fois', async () => {
    const libs = '"libraryfolders" { "0" { "path" "C:\\\\Steam" } "1" { "path" "c:\\\\steam\\\\" } }'
    const c = steamConnector(fakeSteam({ 'C:\\Steam\\steamapps\\libraryfolders.vdf': libs, 'C:\\Steam\\steamapps\\appmanifest_10.acf': acf({ appid: '10', name: 'A' }) }))
    expect(await c.scan()).toHaveLength(1)
  })
  it('Steam absent : non détecté, rien à lire', async () => {
    const c = steamConnector(fakeSteam({}, null))
    expect(await c.detect()).toBe(false)
    expect(await c.scan()).toEqual([])
  })
  it('un manifeste illisible n’empêche pas les autres', async () => {
    const c = steamConnector(fakeSteam({ 'C:\\Steam\\steamapps\\appmanifest_1.acf': '\u0000\u0001', 'C:\\Steam\\steamapps\\appmanifest_2.acf': acf({ appid: '2', name: 'B' }) }))
    expect((await c.scan()).length).toBe(1)
  })
})

// Lecture seule de l'installation Steam réelle de cette machine, quand il y en a une.
describe.runIf(process.platform === 'win32')('Steam réel (si installé)', () => {
  it('détecte les jeux sans redistribuables ni outils', async () => {
    const dir = await realSteamDeps.steamDir()
    if (!dir || !existsSync(join(dir, 'steamapps'))) return
    const games = (await steamConnector().scan()) as { nativeId: string; title: string; uri: string }[]
    for (const g of games) { expect(g.uri).toBe(`steam://rungameid/${g.nativeId}`); expect(g.title).not.toMatch(/^Steamworks|^Proton|^Steam Linux Runtime/) }
  })
})
