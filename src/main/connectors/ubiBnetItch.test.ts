import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseUbisoftRegistry, ubisoftConnector, type UbisoftDeps } from './ubisoft'
import { battleNetConnector, gameFromUninstall, parseUninstall, realBattleNetDeps } from './battlenet'
import { gameFromItch, itchConnector, realItchDeps, type ItchDeps } from './itch'

const UBI = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\5059
    InstallDir    REG_SZ    C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Assassin's Creed Odyssey/
    Language    REG_SZ    fr-FR

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\635
    InstallDir    REG_SZ    D:/Absent/
`

describe('Ubisoft Connect', () => {
  it('lit les installations du registre', () => {
    expect(parseUbisoftRegistry(UBI)).toEqual([
      { id: '5059', dir: "C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Assassin's Creed Odyssey/" }, { id: '635', dir: 'D:/Absent/' }
    ])
  })
  it('décrit les jeux dont le dossier existe, lancement par uplay://', async () => {
    const deps: UbisoftDeps = { installs: async () => parseUbisoftRegistry(UBI), exists: (p) => !p.includes('Absent') }
    const c = ubisoftConnector(deps)
    expect(await c.scan()).toEqual([{
      nativeId: '5059', title: "Assassin's Creed Odyssey", installDir: "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Assassin's Creed Odyssey", uri: 'uplay://launch/5059/0'
    }])
    expect(await ubisoftConnector({ ...deps, installs: async () => null }).detect()).toBe(false)
  })
})

const UNINSTALL = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Overwatch
    DisplayName    REG_SZ    Overwatch 2
    Publisher    REG_SZ    Blizzard Entertainment
    InstallLocation    REG_SZ    C:\\Program Files (x86)\\Overwatch
    DisplayIcon    REG_SZ    C:\\Program Files (x86)\\Overwatch\\Overwatch Launcher.exe
    UninstallString    REG_SZ    "C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=frFR --uid=prometheus --displayname="Overwatch 2"

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Battle.net
    DisplayName    REG_SZ    Battle.net
    Publisher    REG_SZ    Blizzard Entertainment

HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Autre
    DisplayName    REG_SZ    Un logiciel
    Publisher    REG_SZ    Quelqu'un
`
describe('Battle.net', () => {
  const exists = (p: string): boolean => !p.includes('Absent')
  it('ne retient que les jeux Blizzard, avec code de produit et exécutable', () => {
    const [ow, bnet, other] = parseUninstall(UNINSTALL)
    expect(gameFromUninstall(ow, exists)).toEqual({
      nativeId: 'prometheus', title: 'Overwatch 2', installDir: 'C:\\Program Files (x86)\\Overwatch', exe: 'C:\\Program Files (x86)\\Overwatch\\Overwatch Launcher.exe', uri: 'battlenet://Pro'
    })
    expect(gameFromUninstall(bnet, exists)).toBeNull()
    expect(gameFromUninstall(other, exists)).toBeNull()
  })
  it('dossier disparu : ignoré ; registre illisible : non détecté', async () => {
    expect(gameFromUninstall({ ...parseUninstall(UNINSTALL)[0], InstallLocation: 'C:\\Absent' }, exists)).toBeNull()
    expect(await battleNetConnector({ entries: async () => null, exists }).detect()).toBe(false)
    expect(await battleNetConnector({ entries: async () => parseUninstall(UNINSTALL), exists }).detect()).toBe(true)
  })
  it.runIf(process.platform === 'win32')('lecture réelle du registre sans erreur', async () => {
    const games = (await battleNetConnector(realBattleNetDeps).scan()) as { title: string }[]
    for (const g of games) expect(g.title).toBeTruthy()
  }, 30000)
})

describe('itch.io', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kitch-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const verdict = (base: string, path = 'jeu.exe'): string => JSON.stringify({ basePath: base, candidates: [{ path: 'jeu.sh', flavor: 'linux' }, { path, flavor: 'windows' }] })

  it('décrit un jeu installé : exécutable Windows choisi parmi les candidats', () => {
    const exe = join(dir, 'jeu.exe'); writeFileSync(exe, 'MZ')
    expect(gameFromItch({ caveId: 'abc', gameId: 1, title: 'Mon jeu', folder: 'x', location: null, verdict: verdict(dir) }, (p) => p === exe)).toEqual({ nativeId: 'abc', title: 'Mon jeu', exe, installDir: dir, cwd: dir })
  })
  it('écarte sans titre, sans exécutable, introuvable ou verdict illisible', () => {
    const row = { caveId: 'a', gameId: 1, title: 'T', folder: null, location: null, verdict: verdict(dir) }
    expect(gameFromItch({ ...row, title: null }, () => true)).toBeNull()
    expect(gameFromItch(row, () => false)).toBeNull()
    expect(gameFromItch({ ...row, verdict: 'pas du json' }, () => true)).toBeNull()
    expect(gameFromItch({ ...row, verdict: JSON.stringify({ basePath: dir, candidates: [] }) }, () => true)).toBeNull()
  })
  it('lit une base butler.db sur une copie, sans toucher à l’original', () => {
    const base = join(dir, 'games', 'jeu'); mkdirSync(base, { recursive: true }); writeFileSync(join(base, 'jeu.exe'), 'MZ')
    const dbFile = join(dir, 'butler.db')
    const db = new DatabaseSync(dbFile)
    db.exec('CREATE TABLE games (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE install_locations (id TEXT PRIMARY KEY, path TEXT); CREATE TABLE caves (id TEXT PRIMARY KEY, game_id INTEGER, install_location_id TEXT, install_folder_name TEXT, verdict TEXT)')
    db.prepare('INSERT INTO games VALUES (1, ?)').run('Mon jeu itch')
    db.prepare('INSERT INTO install_locations VALUES (?, ?)').run('loc', join(dir, 'games'))
    db.prepare('INSERT INTO caves VALUES (?, 1, ?, ?, ?)').run('cave-1', 'loc', 'jeu', JSON.stringify({ candidates: [{ path: 'jeu.exe', flavor: 'windows' }] }))
    db.close()
    const deps: ItchDeps = { ...realItchDeps, dbPath: () => dbFile }
    const games = itchConnector(deps).scan()
    return games.then((g) => { expect(g).toEqual([{ nativeId: 'cave-1', title: 'Mon jeu itch', exe: join(base, 'jeu.exe'), installDir: base, cwd: base }]) })
  })
  it('itch absent', async () => {
    const c = itchConnector({ dbPath: () => null, rows: () => [], exists: () => true })
    expect(await c.detect()).toBe(false)
    expect(await c.scan()).toEqual([])
  })
})
