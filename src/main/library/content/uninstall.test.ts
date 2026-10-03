import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { migrate } from '../../db/migrations'
import { installPendingContent, uninstallContent } from '../../emulators/content'
import { azaharInstaller, azaharTickets, azaharTitleDir } from '../../emulators/content/azahar'
import { diffGameData, rpcs3Installer, snapshotGameData } from '../../emulators/content/rpcs3'
import type { ContentInstaller, InstallEnv } from '../../emulators/content/types'
import { importPaths } from '../importer'
import { listContent } from '../libraryStore'
import { makeCia, makePkg, nspWithXml } from './content.testutil'
import { makeFullPkg } from './emu.testutil'

// Tests SYNTHÉTIQUES : import ciblé sur un jeu (refus de ce qui n'est pas SON contenu) et désinstallation unitaire. Ils valident la logique de RomVault,
// pas qu'un émulateur ait réellement perdu le contenu (aucun .cia/.pkg réel de mise à jour n'est disponible pour l'essayer).

const GAME_A = '0100000000010000', UPD_A = '0100000000010800', GAME_B = '0100000000020000', UPD_B = '0100000000020800'

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-uninst-')); db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const roms = (): string => join(dir, 'roms')
const opt = (copy = true): Parameters<typeof importPaths>[2] => ({ copy, deleteSource: false, romsDir: roms(), logDir: join(dir, 'logs') })
const put = (name: string, data: Buffer | string): string => { const p = join(dir, 'src', name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); return p }
const gameId = (title: string): number => (db.prepare('SELECT id FROM library WHERE path LIKE ?').get(`%${title}%`) as { id: number }).id
const libraryCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM library').get() as { n: number }).n

describe('import depuis la fiche d un jeu (forGame)', () => {
  beforeEach(async () => {
    await importPaths(db, [put('Game A.nsp', nspWithXml('base', GAME_A)), put('Game B.nsp', nspWithXml('base', GAME_B))], opt())
  })

  it('accepte la mise à jour de CE jeu et la rattache', async () => {
    const a = gameId('Game A')
    const r = await importPaths(db, [put('Upd A.nsp', nspWithXml('update', UPD_A, 65536, GAME_A))], { ...opt(), forGame: { id: a } })
    expect(r.items[0]).toMatchObject({ status: 'attached', contentKind: 'update' })
    expect(listContent(db, a)).toHaveLength(1)
  })

  it('refuse la mise à jour d un AUTRE jeu, avec la raison, sans rien ranger', async () => {
    const a = gameId('Game A')
    const r = await importPaths(db, [put('Upd B.nsp', nspWithXml('update', UPD_B, 65536, GAME_B))], { ...opt(), forGame: { id: a } })
    expect(r.items[0]).toMatchObject({ status: 'error' })
    expect(r.items[0].error).toMatch(/autre jeu/)
    expect(listContent(db, a)).toHaveLength(0)
    expect(listContent(db, gameId('Game B'))).toHaveLength(0)
  })

  it('refuse un jeu (pas un contenu) : aucune entrée de bibliothèque créée', async () => {
    const before = libraryCount()
    const r = await importPaths(db, [put('Game C.nsp', nspWithXml('base', '0100000000030000'))], { ...opt(), forGame: { id: gameId('Game A') } })
    expect(r.items[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/pas une mise à jour/) })
    expect(libraryCount()).toBe(before)
  })

  it('refuse un fichier sans rapport, et un contenu dont le jeu n est pas en bibliothèque (pas de mise en attente)', async () => {
    const a = gameId('Game A')
    const r = await importPaths(db, [put('notes.txt', 'x'), put('Upd Z.nsp', nspWithXml('update', '0100000000090800', 1, '0100000000090000'))], { ...opt(), forGame: { id: a } })
    expect(r.items.every((i) => i.status === 'error')).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS n FROM library_orphans').get() as { n: number }).n).toBe(0)
  })

  it('le doublon est signalé comme tel', async () => {
    const a = gameId('Game A')
    const f = put('Upd A.nsp', nspWithXml('update', UPD_A, 65536, GAME_A))
    await importPaths(db, [f], { ...opt(), forGame: { id: a } })
    const r = await importPaths(db, [f], { ...opt(), forGame: { id: a } })
    expect(r.items[0].status).toBe('duplicate')
  })
})

describe('désinstallation unitaire', () => {
  const fake = (calls: string[][], ok = true): ContentInstaller => ({
    emulatorId: 'fake', managed: false,
    async install() { return { state: 'installed' } },
    async uninstall(_env, items) { calls.push(items.map((i) => i.titleId ?? '')); return ok ? { ok: true } : { ok: false, detail: 'émulateur ouvert' } }
  })

  it('retire le contenu de l émulateur, supprime son fichier rangé et sa ligne ; les autres contenus restent', async () => {
    await importPaths(db, [put('Game A.nsp', nspWithXml('base', GAME_A)), put('Upd A.nsp', nspWithXml('update', UPD_A, 65536, GAME_A)), put('Dlc A.nsp', nspWithXml('dlc', '0100000000011001', 0, GAME_A))], opt())
    const a = gameId('Game A')
    const [first, second] = listContent(db, a)
    const stored = db.prepare('SELECT path FROM library_content WHERE id = ?').get(first.id) as { path: string }
    expect(existsSync(stored.path)).toBe(true)
    const calls: string[][] = []
    const r = await uninstallContent(db, first.id, roms(), { installers: { switch: fake(calls) } })
    expect(r.ok).toBe(true)
    expect(existsSync(stored.path)).toBe(false)
    expect(listContent(db, a).map((c) => c.id)).toEqual([second.id])
    // Le contenu n'étant pas « installed » (Eden n'a rien confirmé en test), l'émulateur n'est appelé que pour un contenu installé.
    expect(calls.length).toBeLessThanOrEqual(1)
  })

  it('appelle l émulateur pour un contenu installé et conserve tout si l émulateur refuse', async () => {
    await importPaths(db, [put('Game A.nsp', nspWithXml('base', GAME_A)), put('Upd A.nsp', nspWithXml('update', UPD_A, 65536, GAME_A))], opt())
    const a = gameId('Game A')
    await installPendingContent(db, a, roms(), 'import', { installers: { switch: fake([]) } })
    const [c] = listContent(db, a)
    expect(c.state).toBe('installed')
    const stored = (db.prepare('SELECT path FROM library_content WHERE id = ?').get(c.id) as { path: string }).path
    const calls: string[][] = []
    const refused = await uninstallContent(db, c.id, roms(), { installers: { switch: fake(calls, false) } })
    expect(refused).toMatchObject({ ok: false, error: 'émulateur ouvert' })
    expect(calls).toEqual([[UPD_A]])
    expect(existsSync(stored)).toBe(true)
    expect(listContent(db, a)).toHaveLength(1)
    expect((await uninstallContent(db, c.id, roms(), { installers: { switch: fake(calls) } })).ok).toBe(true)
    expect(existsSync(stored)).toBe(false)
    expect(listContent(db, a)).toHaveLength(0)
  })

  it('ne supprime jamais un fichier laissé là où l utilisateur l avait mis (mode « ne pas copier »)', async () => {
    const game = put('game.cia', makeCia('0004000000123400'))
    const upd = put('upd.cia', makeCia('0004000E00123400', 1 << 10))
    await importPaths(db, [game, upd], opt(false))
    const a = gameId('game.cia')
    const [c] = listContent(db, a)
    const r = await uninstallContent(db, c.id, roms(), { installers: { n3ds: fake([]) } })
    expect(r.ok).toBe(true)
    expect(existsSync(upd)).toBe(true)
    expect(listContent(db, a)).toHaveLength(0)
  })

  it('un contenu inconnu renvoie une erreur claire', async () => {
    expect(await uninstallContent(db, 999, roms())).toMatchObject({ ok: false })
  })
})

describe('Azahar : désinstallation propre', () => {
  const ZERO = '0'.repeat(32)
  const mk = (...p: string[]): string => { const d = join(...p); mkdirSync(d, { recursive: true }); return d }
  const env = (azDir: string, running = false): InstallEnv => ({ romsDir: roms(), emulator: { dir: azDir, exe: join(azDir, 'azahar.exe') }, isRunning: async () => running })

  it('comme le menu Désinstaller d Azahar : supprime content/ (et le ticket), garde les sauvegardes et les autres titres', async () => {
    const az = mk(dir, 'azahar')
    const title = join(az, 'user', 'sdmc', 'Nintendo 3DS', ZERO, ZERO, 'title', '0004000e', '00123400')
    mk(title, 'content'); writeFileSync(join(title, 'content', '00000001.app'), 'x')
    mk(title, 'data'); writeFileSync(join(title, 'data', 'save.bin'), 'x')
    const base = mk(az, 'user', 'sdmc', 'Nintendo 3DS', ZERO, ZERO, 'title', '00040000', '00123400', 'content')
    const dlc = mk(az, 'user', 'sdmc', 'Nintendo 3DS', ZERO, ZERO, 'title', '0004008c', '00123400', 'content')
    const tik = join(az, 'user', 'nand', 'dbs', 'ticket.db', '0004000E00123400.0000000000000001.tik')
    const otherTik = join(az, 'user', 'nand', 'dbs', 'ticket.db', '0004008C00123400.0000000000000002.tik')
    mk(dirname(tik)); writeFileSync(tik, 't'); writeFileSync(otherTik, 't')
    expect(azaharTitleDir(az, '0004000E00123400')).toBe(title)
    expect(await azaharTickets(az, '0004000E00123400')).toEqual([tik])
    const r = await azaharInstaller.uninstall!(env(az), [{ id: 1, kind: 'update', path: 'x', titleId: '0004000E00123400', version: null, needs: null, installedAt: Date.now() }], { id: 1, console: 'n3ds', title: 't', path: 'p', baseKey: '0004000000123400' })
    expect(r).toMatchObject({ ok: true })
    expect(existsSync(join(title, 'content'))).toBe(false)
    expect(existsSync(join(title, 'data', 'save.bin'))).toBe(true)
    expect(existsSync(tik)).toBe(false)
    expect(existsSync(otherTik)).toBe(true)
    expect(existsSync(base)).toBe(true)
    expect(existsSync(dlc)).toBe(true)
  })

  it('le dossier du titre disparaît quand il ne reste rien dedans', async () => {
    const az = mk(dir, 'azahar')
    const title = join(az, 'user', 'sdmc', 'Nintendo 3DS', ZERO, ZERO, 'title', '0004008c', '00123400')
    mk(title, 'content')
    await azaharInstaller.uninstall!(env(az), [{ id: 1, kind: 'dlc', path: 'x', titleId: '0004008C00123400', version: null, needs: null, installedAt: Date.now() }], { id: 1, console: 'n3ds', title: 't', path: 'p', baseKey: '' })
    expect(existsSync(title)).toBe(false)
  })

  it('refuse tant qu Azahar est ouvert', async () => {
    const az = mk(dir, 'azahar')
    const r = await azaharInstaller.uninstall!(env(az, true), [{ id: 1, kind: 'dlc', path: 'x', titleId: '0004008C00123400', version: null, needs: null }], { id: 1, console: 'n3ds', title: 't', path: 'p', baseKey: '' })
    expect(r).toMatchObject({ ok: false })
  })
})

describe('RPCS3 : suivi des fichiers installés et désinstallation', () => {
  const SERIAL = 'BLES01234'
  const game = { id: 1, console: 'ps3', title: 't', path: 'p', baseKey: SERIAL }
  const env = (rpDir: string, running = false): InstallEnv => ({ romsDir: roms(), emulator: { dir: rpDir, exe: join(rpDir, 'rpcs3.exe') }, isRunning: async () => running })
  const write = (p: string, data: Buffer | string = 'x'): void => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data) }

  it('un paquet qui crée le dossier du jeu : il est enregistré en entier puis retiré, les autres jeux intacts', async () => {
    const rp = join(dir, 'rpcs3')
    const other = join(rp, 'dev_hdd0', 'game', 'NPUB99999', 'USRDIR', 'a.bin')
    write(other)
    const before = await snapshotGameData(rp, SERIAL)
    write(join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'EBOOT.BIN'))
    write(join(rp, 'dev_hdd0', 'game', SERIAL, 'PARAM.SFO'))
    const files = await diffGameData(rp, SERIAL, before)
    expect(files).toEqual([join(rp, 'dev_hdd0', 'game', SERIAL)])
    const r = await rpcs3Installer.uninstall!(env(rp), [{ id: 1, kind: 'update', path: 'x', titleId: 'x', version: null, needs: null, emuFiles: files }], game)
    expect(r).toMatchObject({ ok: true })
    expect(existsSync(join(rp, 'dev_hdd0', 'game', SERIAL))).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('un DLC ajouté à un dossier existant : seuls ses fichiers sont retirés', async () => {
    const rp = join(dir, 'rpcs3')
    const own = join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'base.dat')
    write(own)
    const before = await snapshotGameData(rp, SERIAL)
    write(join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'dlc', 'extra.edat'))
    const files = await diffGameData(rp, SERIAL, before)
    expect(files).toEqual([join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'dlc', 'extra.edat')])
    await rpcs3Installer.uninstall!(env(rp), [{ id: 1, kind: 'dlc', path: 'x', titleId: 'x', version: null, needs: null, emuFiles: files }], game)
    expect(existsSync(own)).toBe(true)
    expect(existsSync(join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'dlc'))).toBe(false)
  })

  it('installé avant le suivi : les fichiers listés par le paquet (comme RPCS3 les lit), à la bonne taille et datant de l’installation, sont retirés — le reste est intact', async () => {
    const rp = join(dir, 'rpcs3')
    const other = join(rp, 'dev_hdd0', 'game', 'NPUB99999', 'a.bin')
    write(join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'EBOOT.BIN'), Buffer.alloc(5, 7)); write(other)
    const pkg = put('patch.pkg', makeFullPkg({ serial: SERIAL, flags: 0x10, entries: [{ name: 'USRDIR', folder: true }, { name: 'USRDIR/EBOOT.BIN', data: Buffer.alloc(5, 7) }] }))
    const r = await rpcs3Installer.uninstall!(env(rp), [{ id: 1, kind: 'update', path: pkg, titleId: 'x', version: null, needs: null, emuFiles: null, installedAt: Date.now() }], game)
    expect(r).toMatchObject({ ok: true, removed: [join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'EBOOT.BIN')] })
    expect(r && (r as { leftover?: string }).leftover).toBeUndefined()
    expect(existsSync(join(rp, 'dev_hdd0', 'game', SERIAL))).toBe(false) // dossiers devenus vides retirés
    expect(existsSync(other)).toBe(true)
  })

  it('installé avant le suivi, DLC qui déclare son propre dossier (métadonnée 0xA) : ses fichiers partent, ceux du jeu restent', async () => {
    const rp = join(dir, 'rpcs3')
    const base = join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'EBOOT.BIN')
    const dlcDir = join(rp, 'dev_hdd0', 'game', 'BLES01234DLC1')
    write(base); write(join(dlcDir, 'USRDIR', 'x.edat'), Buffer.alloc(3, 9))
    const pkg = put('dlc.pkg', makeFullPkg({ serial: SERIAL, installDir: 'BLES01234DLC1', entries: [{ name: 'USRDIR/x.edat', data: Buffer.alloc(3, 9) }] }))
    await rpcs3Installer.uninstall!(env(rp), [{ id: 1, kind: 'dlc', path: pkg, titleId: 'x', version: null, needs: null, emuFiles: null, installedAt: Date.now() }], game)
    expect(existsSync(dlcDir)).toBe(false)
    expect(existsSync(base)).toBe(true)
  })

  it('installé avant le suivi, DLC rangé dans le dossier du jeu : rien n est supprimé au hasard, le reste est signalé', async () => {
    const rp = join(dir, 'rpcs3')
    const keep = join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'a.bin')
    write(keep)
    const pkg = put('dlc2.pkg', makePkg({ platform: 1, serial: SERIAL, contentType: 4 }))
    const r = await rpcs3Installer.uninstall!(env(rp), [{ id: 1, kind: 'dlc', path: pkg, titleId: 'x', version: null, needs: null, emuFiles: null }], game)
    expect(r).toMatchObject({ ok: true, leftover: 'RPCS3' })
    expect(existsSync(keep)).toBe(true)
  })

  it('un jeu installé depuis un .pkg PSN : sa mise à jour ne fait pas supprimer le jeu lui-même', async () => {
    const rp = join(dir, 'rpcs3')
    const keep = join(rp, 'dev_hdd0', 'game', SERIAL, 'USRDIR', 'EBOOT.BIN')
    write(keep)
    const pkg = put('patch2.pkg', makePkg({ platform: 1, serial: SERIAL, contentType: 4, flags: 0x10 }))
    const r = await rpcs3Installer.uninstall!(env(rp), [{ id: 1, kind: 'update', path: pkg, titleId: 'x', version: null, needs: null, emuFiles: null }], { ...game, path: 'C:/jeux/base.pkg' })
    expect(r).toMatchObject({ ok: true, leftover: 'RPCS3' })
    expect(existsSync(keep)).toBe(true)
  })

  it('ne sort jamais de dev_hdd0/game, même avec un chemin enregistré piégé', async () => {
    const rp = join(dir, 'rpcs3')
    const outside = join(dir, 'precieux.txt')
    write(outside)
    mkdirSync(join(rp, 'dev_hdd0', 'game'), { recursive: true })
    await rpcs3Installer.uninstall!(env(rp), [{ id: 1, kind: 'dlc', path: 'x', titleId: 'x', version: null, needs: null, emuFiles: [outside, join(rp, 'dev_hdd0', 'game', '..', '..', '..', 'precieux.txt')] }], game)
    expect(existsSync(outside)).toBe(true)
  })

  it('refuse tant que RPCS3 est ouvert', async () => {
    const rp = join(dir, 'rpcs3')
    mkdirSync(rp, { recursive: true })
    expect(await rpcs3Installer.uninstall!(env(rp, true), [], game)).toMatchObject({ ok: false })
  })
})
