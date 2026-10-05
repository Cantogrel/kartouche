import { describe, expect, it } from 'vitest'
import { epicConnector, gameFromEpicManifest, realEpicDeps, type EpicDeps } from './epic'
import { gameFromRegistry, gogConnector, parseRegGames, realGogDeps } from './gog'

const item = (o: Record<string, unknown> = {}): string => JSON.stringify({
  DisplayName: 'The Escapists 2', AppName: 'Fowl', MainGameAppName: 'Fowl', InstallLocation: 'C:/Program Files/Epic Games/TheEscapists2', LaunchExecutable: 'TheEscapists2.exe',
  CatalogNamespace: 'ns1', CatalogItemId: 'item1', AppCategories: ['public', 'games', 'applications'], bIsIncompleteInstall: false, ...o
})

describe('Epic', () => {
  it('décrit un jeu : lancement par Epic, exécutable en repli', () => {
    expect(gameFromEpicManifest(item())).toEqual({
      nativeId: 'Fowl', title: 'The Escapists 2', installDir: 'C:\\Program Files\\Epic Games\\TheEscapists2',
      exe: 'C:\\Program Files\\Epic Games\\TheEscapists2\\TheEscapists2.exe', cwd: 'C:\\Program Files\\Epic Games\\TheEscapists2',
      uri: 'com.epicgames.launcher://apps/ns1%3Aitem1%3AFowl?action=launch&silent=true'
    })
  })
  it('écarte DLC, extensions, installations incomplètes et manifestes illisibles', () => {
    expect(gameFromEpicManifest(item({ AppName: 'FowlDlc', MainGameAppName: 'Fowl' }))).toBeNull()
    expect(gameFromEpicManifest(item({ AppCategories: ['public', 'addons'] }))).toBeNull()
    expect(gameFromEpicManifest(item({ bIsIncompleteInstall: true }))).toBeNull()
    expect(gameFromEpicManifest(item({ DisplayName: '' }))).toBeNull()
    expect(gameFromEpicManifest('pas du json')).toBeNull()
    expect(gameFromEpicManifest('null')).toBeNull()
  })
  it('lit les manifestes .item d’un dossier et ignore le reste', async () => {
    const files: Record<string, string> = { 'M\\a.item': item(), 'M\\b.item': item({ AppName: 'B', MainGameAppName: 'B', DisplayName: 'B' }), 'M\\c.txt': item(), 'M\\bad.item': '{' }
    const deps: EpicDeps = { manifestsDir: () => 'M', listDir: async () => Object.keys(files).map((k) => k.slice(2)), readText: async (p) => files[p] ?? null }
    const c = epicConnector(deps)
    expect(await c.detect()).toBe(true)
    expect((await c.scan()).length).toBe(2)
    expect(await epicConnector({ ...deps, manifestsDir: () => null }).detect()).toBe(false)
  })
})

const REG = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1094900565
    gameName    REG_SZ    RimWorld
    gameID    REG_SZ    1094900565
    path    REG_SZ    C:\\Games\\RimWorld
    workingDir    REG_SZ    C:\\Games\\RimWorld
    exe    REG_SZ    C:\\Games\\RimWorld\\RimWorldWin64.exe
    launchParam    REG_SZ
    dependsOn    REG_SZ

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1233017772
    gameName    REG_SZ    RimWorld - Royalty
    gameID    REG_SZ    1233017772
    path    REG_SZ    C:\\Games\\RimWorld
    exe    REG_SZ    C:\\Games\\RimWorld\\RimWorldWin64.exe
    dependsOn    REG_SZ    1094900565

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1094900565\\autre
    gameName    REG_SZ    Sous-clé ignorée
`

describe('GOG', () => {
  it('découpe la sortie du registre : un jeu par sous-clé directe', () => {
    const games = parseRegGames(REG)
    expect(games.map((g) => g.gameID)).toEqual(['1094900565', '1233017772'])
    expect(games[0].launchParam).toBe('')
  })
  it('décrit un jeu lancé directement et écarte les DLC', () => {
    const [a, dlc] = parseRegGames(REG)
    expect(gameFromRegistry(a)).toEqual({ nativeId: '1094900565', title: 'RimWorld', exe: 'C:\\Games\\RimWorld\\RimWorldWin64.exe', installDir: 'C:\\Games\\RimWorld', cwd: 'C:\\Games\\RimWorld' })
    expect(gameFromRegistry(dlc)).toBeNull()
  })
  it('sans exécutable connu, ni lancement possible : ignoré ; recompose depuis exeFile', () => {
    expect(gameFromRegistry({ gameID: '1', gameName: 'X' })).toBeNull()
    expect(gameFromRegistry({ gameID: '1', gameName: 'X', path: 'D:\\X\\', exeFile: 'x.exe' })?.exe).toBe('D:\\X\\x.exe')
  })
  it('non détecté sans clés', async () => {
    const c = gogConnector({ games: async () => null })
    expect(await c.detect()).toBe(false)
    expect(await c.scan()).toEqual([])
    expect(await gogConnector({ games: async () => parseRegGames(REG) }).detect()).toBe(true)
  })
})

describe.runIf(process.platform === 'win32')('installations réelles (lecture seule)', () => {
  it('Epic', async () => {
    if (!realEpicDeps.manifestsDir()) return
    for (const g of (await epicConnector().scan()) as { uri?: string; title: string }[]) { expect(g.title).toBeTruthy(); expect(g.uri ?? '').toMatch(/^(com\.epicgames\.launcher:\/\/|$)/) }
  })
  it('GOG', async () => {
    if (!(await realGogDeps.games())) return
    const games = (await gogConnector().scan()) as { exe: string }[]
    for (const g of games) expect(g.exe).toMatch(/\.exe$/i)
  }, 30000)
})
