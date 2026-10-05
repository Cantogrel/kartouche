import { describe, expect, it } from 'vitest'
import { isLaunchUri } from '@shared/connectors'
import { gameFromXboxPackage, publisherId, realXboxDeps, xboxConnector, type XboxDeps } from './xbox'
import { eaConnector, gameFromEa, parseEaRegistry, readInstallerData, type EaDeps } from './ea'

const MS = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
const manifest = (name = 'Microsoft.4297127D64EC6', display = 'Minecraft Launcher', app = 'Minecraft'): string =>
  `<?xml version="1.0"?><Package><Identity Name="${name}" Publisher="${MS}" Version="2.6.2.0" /><Properties><DisplayName>${display}</DisplayName></Properties><Applications><Application Id="${app}" Executable="GameLaunchHelper.exe" /></Applications></Package>`

describe('Xbox', () => {
  it('calcule l’identifiant d’éditeur d’un paquet (valeur connue de Microsoft)', () => {
    expect(publisherId(MS)).toBe('8wekyb3d8bbw'.padEnd(13, 'e'))
  })
  it('décrit un jeu : paquet, nom, lancement par le menu Démarrer', () => {
    expect(gameFromXboxPackage(manifest(), null, 'Minecraft Launcher', 'C:\\XboxGames\\Minecraft Launcher\\Content')).toEqual({
      nativeId: 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', title: 'Minecraft Launcher', installDir: 'C:\\XboxGames\\Minecraft Launcher\\Content',
      uri: 'shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'
    })
  })
  it('nom affiché indirect (ms-resource) : MicrosoftGame.Config, sinon le dossier', () => {
    const m = manifest('X.Y', 'ms-resource:AppName')
    expect(gameFromXboxPackage(m, '<Game><ShellVisuals DefaultDisplayName="Mon Jeu &amp; Co" /></Game>', 'Dossier', 'c')?.title).toBe('Mon Jeu & Co')
    expect(gameFromXboxPackage(m, null, 'Dossier', 'c')?.title).toBe('Dossier')
  })
  it('refuse un manifeste sans identité ou sans application', () => {
    expect(gameFromXboxPackage('<Package></Package>', null, 'd', 'c')).toBeNull()
    expect(gameFromXboxPackage(manifest().replace(/<Applications>.*<\/Applications>/, ''), null, 'd', 'c')).toBeNull()
  })
  it('n’accepte sous shell: que l’application d’un paquet', () => {
    expect(isLaunchUri('shell:AppsFolder\\Microsoft.X_8wekyb3d8bbwe!Game')).toBe(true)
    for (const bad of ['shell:AppsFolder\\..\\x', 'shell:startup', 'shell:AppsFolder\\a!b c', 'shell:::{guid}']) expect(isLaunchUri(bad)).toBe(false)
  })
  it('parcourt les dossiers XboxGames', async () => {
    const files: Record<string, string> = { 'X:\\XboxGames\\A\\Content\\appxmanifest.xml': manifest('A.A', 'Jeu A'), 'X:\\XboxGames\\GameSave\\pgs': 'x' }
    const deps: XboxDeps = { roots: () => ['X:\\XboxGames'], listDir: async () => ['A', 'GameSave'], readText: async (p) => files[p] ?? null }
    const games = (await xboxConnector(deps).scan()) as { title: string }[]
    expect(games.map((g) => g.title)).toEqual(['Jeu A'])
    expect(await xboxConnector({ ...deps, roots: () => [] }).detect()).toBe(false)
  })
  it.runIf(process.platform === 'win32')('Xbox réel (lecture seule)', async () => {
    if (realXboxDeps.roots().length === 0) return
    for (const g of (await xboxConnector().scan()) as { uri: string }[]) expect(g.uri).toMatch(/^shell:AppsFolder\\/)
  })
})

const REG = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\EA Games

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\EA Games\\Battlefield 4
    Install Dir    REG_SZ    C:\\Program Files\\EA Games\\Battlefield 4\\
    DisplayName    REG_SZ    Battlefield 4™

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\EA Games\\Absent
    Install Dir    REG_SZ    C:\\nulle part
`
const XML = `<DiPManifest><gameTitles><gameTitle><localization locale="fr_FR">Jeu FR</localization></gameTitle></gameTitles><contentIDs><contentID>1015365</contentID></contentIDs><runtime><launcher><filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA\\Install Dir]bf4.exe</filePath></launcher></runtime></DiPManifest>`

describe('EA app', () => {
  it('découpe le registre et lit installerdata.xml', () => {
    expect(parseEaRegistry(REG).map((g) => [g.__key, g['Install Dir']])).toEqual([['Battlefield 4', 'C:\\Program Files\\EA Games\\Battlefield 4\\'], ['Absent', 'C:\\nulle part']])
    expect(readInstallerData(XML)).toEqual({ title: 'Jeu FR', contentId: '1015365', exe: 'bf4.exe' })
    expect(readInstallerData('n’importe quoi')).toEqual({ title: undefined, contentId: undefined, exe: undefined })
  })
  const deps = (over: Partial<EaDeps> = {}): EaDeps => ({
    registryGames: async () => parseEaRegistry(REG),
    readText: async (p) => (p.endsWith('installerdata.xml') ? XML : null),
    exists: (p) => !p.includes('nulle part'),
    listDir: async () => [],
    ...over
  })
  it('décrit un jeu installé : lancement par l’EA app, exécutable en repli', async () => {
    const [bf4] = parseEaRegistry(REG)
    expect(await gameFromEa(bf4, deps())).toEqual({
      nativeId: '1015365', title: 'Jeu FR', installDir: 'C:\\Program Files\\EA Games\\Battlefield 4', exe: 'C:\\Program Files\\EA Games\\Battlefield 4\\bf4.exe',
      cwd: 'C:\\Program Files\\EA Games\\Battlefield 4', uri: 'origin2://game/launch/?offerIds=1015365'
    })
  })
  it('ignore un dossier d’installation disparu, et sans XML retombe sur le registre', async () => {
    const c = eaConnector(deps())
    expect((await c.scan()).length).toBe(1)
    const noXml = await gameFromEa(parseEaRegistry(REG)[0], deps({ readText: async () => null }))
    expect(noXml).toBeNull()
    expect(await eaConnector(deps({ registryGames: async () => null })).detect()).toBe(false)
  })
})
