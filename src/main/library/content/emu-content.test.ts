import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { migrate } from '../../db/migrations'
import { readZipEntryText } from '../hash'
import { saveEmulator } from '../../emulators/emulatorStore'
import { splitShared, uninstallContent } from '../../emulators/content'
import { azaharTitleDir, makeAzaharInstaller } from '../../emulators/content/azahar'
import { cemuGamePaths, cemuInstaller, registerCemuGamePath } from '../../emulators/content/cemu'
import { makeRpcs3Installer } from '../../emulators/content/rpcs3'
import { diffTrees, expandCreatedRoots, overlaps, snapshotTrees } from '../../emulators/content/snapshot'
import type { ContentInstaller, ContentRef, GameRef, InstallEnv, UninstallRef } from '../../emulators/content/types'
import { makeVita3kInstaller, vita3kPrefPath, type Vita3kRunners } from '../../emulators/content/vita3k'
import { importPaths } from '../importer'
import { listLibrary } from '../libraryStore'
import { makeCia, makeMetaXml, nspWithXml } from './content.testutil'
import { makeAppXml, makeCosXml, makeFullPkg, makeSfo, makeVitaArchive, makeWiiUTmd, makeWua, makeWuaFiles, makeZipStored } from './emu.testutil'
import { listPkgFiles } from './pkgFiles'
import { probeVitaArchive, readVitaArchive, type VitaArchiveInfo } from './vita'
import { checkWiiUTitle } from './wiiu'
import { isVWiiWrapper, probeWua, readWuaFiles, readWuaTitles, VWII_REASON } from './wua'

// Suivi précis des fichiers installés, désinstallation sûre, Cemu et Vita3K. TESTS SYNTHÉTIQUES : les processus d'émulateur sont remplacés par des « exécuteurs » qui écrivent ce que
// l'émulateur écrirait (d'après son code source). Ils valident la logique de RomVault (tracking, provenance, partage, refus), JAMAIS qu'un émulateur reconnaît le contenu — voir docs/content-support.md.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-emu-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (p: string, data: Buffer | string = 'x'): string => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); return p }
const roms = (): string => join(dir, 'roms')
const env = (emu: string, running = false, exe = 'emu.exe'): InstallEnv => ({ romsDir: roms(), emulator: { dir: emu, exe: join(emu, exe) }, isRunning: async () => running })
const game = (console: string, baseKey: string): GameRef => ({ id: 1, console, title: 'Jeu', path: join(dir, 'jeu.bin'), baseKey })
const item = (over: Partial<ContentRef> & { path: string }): ContentRef => ({ id: 1, kind: 'update', titleId: null, version: null, needs: null, ...over })
const uref = (over: Partial<UninstallRef> & { path: string }): UninstallRef => ({ id: 1, kind: 'update', titleId: null, version: null, needs: null, ...over })

// --- snapshot ------------------------------------------------------------------------------------------------------------------------------
describe('suivi des fichiers (snapshot)', () => {
  it('crée = nouveau ; réécrit = déjà là mais changé ; le reste n’est jamais compté', async () => {
    const root = join(dir, 'emu', 'title')
    write(join(root, 'ancien.bin'), 'a'); write(join(root, 'reecrit.bin'), 'v1')
    const before = await snapshotTrees([root])
    write(join(root, 'nouveau.bin'), 'n'); write(join(root, 'reecrit.bin'), 'v2-plus-long'); write(join(root, 'sous', 'x.bin'))
    const d = await diffTrees(before, [root])
    expect(d.created.sort()).toEqual([join(root, 'nouveau.bin'), join(root, 'sous')].sort())
    expect(d.modified).toEqual([join(root, 'reecrit.bin')])
  })
  it('une racine qui n’existait pas est créée en bloc ; expandCreatedRoots la remplace par son contenu (le conteneur n’est pas à nous)', async () => {
    const root = join(dir, 'emu', 'title', 'x')
    const before = await snapshotTrees([root])
    write(join(root, 'content', 'a.app')); write(join(root, 'content', 'b.tmd'))
    const d = await diffTrees(before, [root])
    expect(d.created).toEqual([root])
    expect(await expandCreatedRoots(d.created, [root])).toEqual([join(root, 'content')])
  })
  it('overlaps : même chemin, ou l’un dans l’autre', () => {
    expect(overlaps('E:\\a\\b', 'e:\\a\\b')).toBe(true)
    expect(overlaps('E:\\a', 'E:\\a\\b\\c')).toBe(true)
    expect(overlaps('E:\\a\\b', 'E:\\a\\bc')).toBe(false)
  })
})

describe('fichiers partagés entre contenus (splitShared)', () => {
  it('un fichier partagé n’est jamais « libre » ; les autres le sont', async () => {
    const { free, kept } = await splitShared(['E:\\emu\\a.bin', 'E:\\emu\\b.bin'], ['E:\\emu\\b.bin'])
    expect(free).toEqual(['E:\\emu\\a.bin'])
    expect(kept).toEqual(['E:\\emu\\b.bin'])
  })
  it('un dossier qui porte les fichiers d’un autre contenu est examiné élément par élément : les siens partent, ceux de l’autre restent, le dossier aussi', async () => {
    const d = join(dir, 'emu', 'game', 'X')
    write(join(d, 'mien.bin')); write(join(d, 'autre.bin'))
    const { free, kept } = await splitShared([d], [join(d, 'autre.bin')])
    expect(free).toEqual([join(d, 'mien.bin')])
    expect(kept.sort()).toEqual([join(d, 'autre.bin'), d].sort())
  })
})

describe('uninstallContent : partage, refus, fichier source', () => {
  let db: DatabaseSync
  beforeEach(() => { db = new DatabaseSync(':memory:'); migrate(db) })
  const setup = (files: Record<number, string[] | null>): { stored: string; calls: string[][] } => {
    db.prepare("INSERT INTO library (console, title, path, size, match, title_id, added_at) VALUES ('switch', 'J', ?, 1, 'name', 'K', 1)").run(join(dir, 'j.nsp'))
    const stored = write(join(roms(), 'switch', '.content', 'K', 'maj.nsp'))
    for (const [id, f] of Object.entries(files)) {
      db.prepare("INSERT INTO library_content (id, library_id, kind, title_id, version, label, path, size, added_at, state, emu_files, installed_at) VALUES (?, 1, 'update', ?, '1', 'x', ?, 1, 1, 'installed', ?, 5)")
        .run(Number(id), `T${id}`, Number(id) === 1 ? stored : write(join(roms(), 'switch', '.content', 'K', `autre${id}.nsp`)), f === null ? null : JSON.stringify(f))
    }
    return { stored, calls: [] }
  }
  const spy = (calls: string[][], ok = true): ContentInstaller => ({ emulatorId: 'eden', managed: true, install: async () => ({ state: 'installed' }), uninstall: async (_e, items) => { calls.push(items[0].emuFiles ?? ['<null>']); return ok ? { ok: true } : { ok: false, detail: 'refusé' } } })

  it('un fichier écrit aussi par un autre contenu n’est PAS passé à l’installateur ; le dernier propriétaire le retire', async () => {
    const { calls } = setup({ 1: ['E:\\emu\\commun.bin', 'E:\\emu\\a.bin'], 2: ['E:\\emu\\commun.bin'] })
    const r1 = await uninstallContent(db, 1, roms(), { installers: { switch: spy(calls) } })
    expect(calls[0]).toEqual(['E:\\emu\\a.bin'])
    expect(r1.leftover).toMatch(/partagés/)
    const r2 = await uninstallContent(db, 2, roms(), { installers: { switch: spy(calls) } })
    expect(calls[1]).toEqual(['E:\\emu\\commun.bin'])
    expect(r2.ok).toBe(true)
  })
  it('désinstallation refusée par l’émulateur : le fichier source et la ligne sont conservés', async () => {
    const { stored, calls } = setup({ 1: ['E:\\emu\\a.bin'] })
    const r = await uninstallContent(db, 1, roms(), { installers: { switch: spy(calls, false) } })
    expect(r.ok).toBe(false)
    expect(existsSync(stored)).toBe(true)
    expect((db.prepare('SELECT COUNT(*) AS n FROM library_content').get() as { n: number }).n).toBe(1)
  })
  it('un fichier source qui n’est pas rangé par RomVault (chez l’utilisateur) n’est jamais supprimé', async () => {
    setup({ 1: [] })
    const mine = write(join(dir, 'chez-moi', 'maj.nsp'))
    db.prepare('UPDATE library_content SET path = ? WHERE id = 1').run(mine)
    await uninstallContent(db, 1, roms(), { installers: { switch: spy([]) } })
    expect(existsSync(mine)).toBe(true)
  })
})

// --- Azahar -------------------------------------------------------------------------------------------------------------------------------
describe('Azahar : suivi exact, provenance, désinstallation', () => {
  const TID = '0004000E00123400'
  const ZERO = '0'.repeat(32)
  const emu = (): string => join(dir, 'azahar')
  const titleDir = (): string => azaharTitleDir(emu(), TID)!
  const tikPath = (): string => join(emu(), 'user', 'nand', 'dbs', 'ticket.db', `${TID}.0000000000000001.tik`)
  const cia = (): string => write(join(dir, 'maj.cia'), makeCia(TID))
  /** Ce qu'Azahar écrit en installant ce .cia (am.cpp) : content/<id>.tmd, content/<id>.app, ticket. */
  const goodRun = async (): Promise<boolean> => { write(join(titleDir(), 'content', '00000000.tmd')); write(join(titleDir(), 'content', '00000001.app')); write(tikPath()); return true }

  it('installation : ce qui est créé (content/ et le ticket) est enregistré, rien d’autre', async () => {
    write(join(emu(), 'user', 'nand', 'dbs', 'ticket.db', 'AUTRE.tik'))
    const out = await makeAzaharInstaller(goodRun).install(env(emu()), item({ path: cia(), titleId: TID }), game('n3ds', '0004000000123400'), 'launch')
    expect(out).toMatchObject({ state: 'installed' })
    expect(out.emuFiles!.sort()).toEqual([join(titleDir(), 'content'), tikPath()].sort())
  })
  it('à l’import, rien n’est lancé (la fenêtre d’Azahar s’ouvrirait) : en attente du lancement', async () => {
    let ran = false
    const out = await makeAzaharInstaller(async () => { ran = true; return true }).install(env(emu()), item({ path: cia(), titleId: TID }), game('n3ds', 'k'), 'import')
    expect(out).toMatchObject({ state: 'pending', reason: 'onLaunch' })
    expect(ran).toBe(false)
  })
  it('installation partielle (TMD sans aucun .app) : JAMAIS annoncée terminée', async () => {
    const out = await makeAzaharInstaller(async () => { write(join(titleDir(), 'content', '00000000.tmd')); return true }).install(env(emu()), item({ path: cia(), titleId: TID }), game('n3ds', 'k'), 'launch')
    expect(out).toMatchObject({ state: 'failed' })
    expect(out.detail).toMatch(/incomplète/)
  })
  it('Azahar refuse (journal) : en échec', async () => {
    expect((await makeAzaharInstaller(async () => false).install(env(emu()), item({ path: cia(), titleId: TID }), game('n3ds', 'k'), 'launch')).state).toBe('failed')
  })
  it('titre DÉJÀ présent (installé à la main) : rien n’appartient à RomVault, et la désinstallation n’y touche pas', async () => {
    write(join(titleDir(), 'content', '00000000.tmd'), 'v1'); write(join(titleDir(), 'content', '00000001.app'), 'v1')
    const rewrite = async (): Promise<boolean> => { write(join(titleDir(), 'content', '00000001.app'), 'v2-reecrit'); return true }
    const out = await makeAzaharInstaller(rewrite).install(env(emu()), item({ path: cia(), titleId: TID }), game('n3ds', 'k'), 'launch')
    expect(out).toMatchObject({ state: 'installed' })
    expect(out.emuFiles).toEqual([])
    expect(out.detail).toMatch(/déjà présent/)
    const r = await makeAzaharInstaller(goodRun).uninstall!(env(emu()), [uref({ path: 'x', titleId: TID, emuFiles: out.emuFiles })], game('n3ds', 'k'))
    expect(r).toMatchObject({ ok: true, leftover: 'Azahar' })
    expect(readFileSync(join(titleDir(), 'content', '00000001.app'), 'utf8')).toBe('v2-reecrit')
  })
  it('désinstallation suivie : content/ et ticket partent, la sauvegarde (data/) et les autres titres restent', async () => {
    await goodRun()
    write(join(titleDir(), 'data', 'save.bin'))
    const other = write(join(azaharTitleDir(emu(), '0004008C00123400')!, 'content', 'dlc.app'))
    const r = await makeAzaharInstaller(goodRun).uninstall!(env(emu()), [uref({ path: 'x', titleId: TID, emuFiles: [join(titleDir(), 'content'), tikPath()] })], game('n3ds', 'k'))
    expect(r).toMatchObject({ ok: true })
    expect(existsSync(join(titleDir(), 'content'))).toBe(false)
    expect(existsSync(tikPath())).toBe(false)
    expect(existsSync(join(titleDir(), 'data', 'save.bin'))).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
  it('contenu SANS suivi : retiré seulement si son dossier content/ date de l’installation enregistrée', async () => {
    await goodRun()
    const r = await makeAzaharInstaller(goodRun).uninstall!(env(emu()), [uref({ path: 'x', titleId: TID, emuFiles: null, installedAt: Date.now() })], game('n3ds', 'k'))
    expect(r).toMatchObject({ ok: true })
    expect(existsSync(join(titleDir(), 'content'))).toBe(false)
  })
  it('contenu SANS suivi, installation enregistrée sans rapport avec la date du dossier : refusé, rien supprimé', async () => {
    await goodRun()
    const r = await makeAzaharInstaller(goodRun).uninstall!(env(emu()), [uref({ path: 'x', titleId: TID, emuFiles: null, installedAt: Date.now() - 3 * 24 * 3600_000 })], game('n3ds', 'k'))
    expect(r).toMatchObject({ ok: true, leftover: 'Azahar' })
    expect(existsSync(join(titleDir(), 'content', '00000001.app'))).toBe(true)
  })
  it('contenu SANS suivi ni date d’installation : refusé', async () => {
    await goodRun()
    const r = await makeAzaharInstaller(goodRun).uninstall!(env(emu()), [uref({ path: 'x', titleId: TID, emuFiles: null })], game('n3ds', 'k'))
    expect(r).toMatchObject({ leftover: 'Azahar' })
    expect(existsSync(join(titleDir(), 'content'))).toBe(true)
  })
  it('Azahar ouvert : aucune opération dangereuse', async () => {
    await goodRun()
    const r = await makeAzaharInstaller(goodRun).uninstall!(env(emu(), true), [uref({ path: 'x', titleId: TID, emuFiles: [join(titleDir(), 'content')] })], game('n3ds', 'k'))
    expect(r).toMatchObject({ ok: false })
    expect(existsSync(join(titleDir(), 'content'))).toBe(true)
  })
  it('un chemin enregistré hors du dossier utilisateur d’Azahar n’est jamais supprimé', async () => {
    const outside = write(join(dir, 'precieux.txt'))
    await makeAzaharInstaller(goodRun).uninstall!(env(emu()), [uref({ path: 'x', titleId: TID, emuFiles: [outside] })], game('n3ds', 'k'))
    expect(existsSync(outside)).toBe(true)
  })
  void ZERO
})

// --- RPCS3 --------------------------------------------------------------------------------------------------------------------------------
describe('RPCS3 : liste des fichiers du paquet, suivi, désinstallation sans suivi', () => {
  const SERIAL = 'BLES01234'
  const emu = (): string => join(dir, 'rpcs3')
  const gameRoot = (): string => join(emu(), 'dev_hdd0', 'game')
  const pkgFile = (entries: { name: string; data?: Buffer; folder?: boolean }[], over: { installDir?: string; flags?: number } = {}): string => write(join(dir, 'patch.pkg'), makeFullPkg({ serial: SERIAL, entries, ...over }))
  const fullEntries = [{ name: 'USRDIR', folder: true }, { name: 'USRDIR/EBOOT.BIN', data: Buffer.from('eboot-patch') }, { name: 'USRDIR/data.dat', data: Buffer.from('donnees') }]
  const log = (pkg: string, ok = true): void => { write(join(emu(), 'log', 'RPCS3.log'), `${ok ? 'Successfully installed' : 'Failed to install'} ${pkg} (title_id=${SERIAL})\n`) }
  /** Ce que RPCS3 écrit : chaque fichier du paquet sous dev_hdd0/game/<série>/. */
  const runWith = (pkg: string, skip: string[] = [], ok = true) => async (): Promise<number | null> => {
    for (const e of (await listPkgFiles(pkg))!.entries) {
      const target = join(gameRoot(), SERIAL, ...e.name.split('/'))
      // RPCS3 n'écrase un fichier déjà présent que si l'entrée porte le drapeau OVERWRITE (unpkg.cpp).
      if (!e.folder && !skip.includes(e.name) && (!existsSync(target) || e.overwrite)) write(target, Buffer.alloc(e.size, 7))
    }
    log(pkg, ok)
    return 0
  }
  void runWith

  it('listPkgFiles lit la table de fichiers chiffrée comme RPCS3 (noms, tailles, dossiers, dossier d’installation)', async () => {
    const listing = (await listPkgFiles(pkgFile(fullEntries)))!
    expect(listing.installDir).toBe(SERIAL)
    expect(listing.entries).toEqual([
      { name: 'USRDIR', size: 0, folder: true, overwrite: false },
      { name: 'USRDIR/EBOOT.BIN', size: 11, folder: false, overwrite: false },
      { name: 'USRDIR/data.dat', size: 7, folder: false, overwrite: false }
    ])
    expect((await listPkgFiles(pkgFile(fullEntries, { installDir: 'BLES01234DLC1' })))!.installDir).toBe('BLES01234DLC1')
  })
  it('listPkgFiles refuse ce qu’il ne peut pas lire avec certitude (en-tête seul, nom qui sort du dossier)', async () => {
    expect(await listPkgFiles(write(join(dir, 'vide.pkg'), 'rien'))).toBeNull()
    expect(await listPkgFiles(pkgFile([{ name: '../../evil.bin', data: Buffer.from('x') }]))).toBeNull()
  })
  it('installation : seuls les fichiers CRÉÉS sont enregistrés ; ceux que le paquet réécrit ne sont pas à RomVault', async () => {
    const pkg = pkgFile(fullEntries)
    const existing = write(join(gameRoot(), SERIAL, 'USRDIR', 'data.dat'), Buffer.alloc(7, 1)) // déjà là (jeu) ; le paquet le réécrit
    const out = await makeRpcs3Installer(runWith(pkg)).install(env(emu()), item({ path: pkg }), game('ps3', SERIAL), 'launch')
    expect(out).toMatchObject({ state: 'installed' })
    expect(out.emuFiles).toEqual([join(gameRoot(), SERIAL, 'USRDIR', 'EBOOT.BIN')])
    expect(readFileSync(existing).length).toBe(7)
    expect(readFileSync(existing)[0]).toBe(1) // inchangé : pas de drapeau OVERWRITE
  })
  it('fichier existant écrasé AVEC le drapeau OVERWRITE : l’original est sauvegardé avant, enregistré, et remis à la désinstallation', async () => {
    const entries = [{ name: 'USRDIR/EBOOT.BIN', data: Buffer.from('eboot-patch'), overwrite: true }, { name: 'USRDIR/nouveau.dat', data: Buffer.from('n') }]
    const pkg = write(join(dir, 'p.pkg'), makeFullPkg({ serial: SERIAL, entries }))
    const orig = write(join(gameRoot(), SERIAL, 'USRDIR', 'EBOOT.BIN'), 'EBOOT-ORIGINAL')
    const inst = makeRpcs3Installer(runWith(pkg))
    const out = await inst.install(env(emu()), item({ id: 5, path: pkg }), game('ps3', SERIAL), 'launch')
    expect(out.state).toBe('installed')
    expect(out.emuFiles).toEqual([join(gameRoot(), SERIAL, 'USRDIR', 'nouveau.dat')])
    expect(Object.keys(out.emuBackups!)).toEqual([orig])
    expect(readFileSync(orig).length).toBe(11) // écrasé par le paquet
    const un = await inst.uninstall!(env(emu()), [uref({ id: 5, path: pkg, emuFiles: out.emuFiles, emuBackups: out.emuBackups })], game('ps3', SERIAL))
    expect(un).toMatchObject({ ok: true })
    expect(readFileSync(orig, 'utf8')).toBe('EBOOT-ORIGINAL')
    expect(existsSync(join(gameRoot(), SERIAL, 'USRDIR', 'nouveau.dat'))).toBe(false)
    expect(existsSync(join(dir, 'content-backups', 'rpcs3', '5'))).toBe(false)
  })
  it('fichier existant réécrit SANS le drapeau OVERWRITE (jamais censé arriver) : originaux remis, installation non retenue', async () => {
    const pkg = write(join(dir, 'p2.pkg'), makeFullPkg({ serial: SERIAL, entries: [{ name: 'USRDIR/data.dat', data: Buffer.from('donnees') }] }))
    const orig = write(join(gameRoot(), SERIAL, 'USRDIR', 'data.dat'), 'AAAAAAA')
    const out = await makeRpcs3Installer(async () => { write(orig, 'BBBBBBBB'); log(pkg); return 0 }).install(env(emu()), item({ path: pkg }), game('ps3', SERIAL), 'launch')
    expect(out.state).toBe('failed')
    expect(out.detail).toMatch(/sans sauvegarde/)
  })
  it('sauvegarde d’origine introuvable : désinstallation refusée, rien n’est modifié', async () => {
    const created = write(join(gameRoot(), SERIAL, 'nouveau.dat'))
    const r = await makeRpcs3Installer().uninstall!(env(emu()), [uref({ path: 'x', emuFiles: [created], emuBackups: { [join(gameRoot(), SERIAL, 'a.bin')]: join(dir, 'disparue') } })], game('ps3', SERIAL))
    expect(r).toMatchObject({ ok: false })
    expect(existsSync(created)).toBe(true)
  })
  it('installation incomplète (un fichier du paquet manque) : JAMAIS annoncée terminée', async () => {
    const pkg = pkgFile(fullEntries)
    const out = await makeRpcs3Installer(runWith(pkg, ['USRDIR/data.dat'])).install(env(emu()), item({ path: pkg }), game('ps3', SERIAL), 'launch')
    expect(out.state).toBe('failed')
    expect(out.detail).toMatch(/incomplète/)
  })
  it('verdict « Failed to install » ou pas de journal : en échec, même si des fichiers sont apparus', async () => {
    const pkg = pkgFile(fullEntries)
    expect((await makeRpcs3Installer(runWith(pkg, [], false)).install(env(emu()), item({ path: pkg }), game('ps3', SERIAL), 'launch')).state).toBe('failed')
    expect((await makeRpcs3Installer(async () => null).install(env(emu()), item({ path: pkg }), game('ps3', SERIAL), 'launch')).state).toBe('failed')
  })
  it('RPCS3 ouvert : rien n’est lancé ni supprimé', async () => {
    const pkg = pkgFile(fullEntries)
    let ran = false
    expect((await makeRpcs3Installer(async () => { ran = true; return 0 }).install(env(emu(), true), item({ path: pkg }), game('ps3', SERIAL), 'launch')).reason).toBe('emulatorRunning')
    expect(ran).toBe(false)
    const keep = write(join(gameRoot(), SERIAL, 'a'))
    expect(await makeRpcs3Installer().uninstall!(env(emu(), true), [uref({ path: pkg, emuFiles: [keep] })], game('ps3', SERIAL))).toMatchObject({ ok: false })
    expect(existsSync(keep)).toBe(true)
  })

  describe('contenu installé AVANT le suivi : liste du paquet + taille + date', () => {
    const lay = (pkg: string): void => { for (const e of fullEntries.filter((x) => !x.folder)) write(join(gameRoot(), SERIAL, ...e.name.split('/')), Buffer.alloc(e.data!.length, 7)) ; void pkg }
    const un = (pkg: string, installedAt: number | null, siblings: ContentRef[] = []): Promise<unknown> =>
      makeRpcs3Installer().uninstall!(env(emu()), [uref({ path: pkg, emuFiles: null, installedAt, siblings })], game('ps3', SERIAL))

    it('fichiers de CE paquet, à la bonne taille et datant de l’installation : retirés ; tout le reste intact', async () => {
      const pkg = pkgFile(fullEntries); lay(pkg)
      const other = write(join(gameRoot(), SERIAL, 'USRDIR', 'du-jeu.dat'), 'jeu')
      const r = await un(pkg, Date.now())
      expect(r).toMatchObject({ ok: true })
      expect(existsSync(join(gameRoot(), SERIAL, 'USRDIR', 'EBOOT.BIN'))).toBe(false)
      expect(existsSync(join(gameRoot(), SERIAL, 'USRDIR', 'data.dat'))).toBe(false)
      expect(existsSync(other)).toBe(true)
    })
    it('un fichier dont la TAILLE a changé depuis l’installation n’est pas retiré', async () => {
      const pkg = pkgFile(fullEntries); lay(pkg)
      write(join(gameRoot(), SERIAL, 'USRDIR', 'data.dat'), 'modifie-par-quelquun-d-autre')
      const r = (await un(pkg, Date.now())) as { leftover?: string }
      expect(r.leftover).toBe('RPCS3')
      expect(existsSync(join(gameRoot(), SERIAL, 'USRDIR', 'data.dat'))).toBe(true)
      expect(existsSync(join(gameRoot(), SERIAL, 'USRDIR', 'EBOOT.BIN'))).toBe(false)
    })
    it('un fichier plus ANCIEN que l’installation (pas écrit par elle) n’est pas retiré', async () => {
      const pkg = pkgFile(fullEntries); lay(pkg)
      const old = join(gameRoot(), SERIAL, 'USRDIR', 'EBOOT.BIN')
      utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'))
      await un(pkg, Date.now())
      expect(existsSync(old)).toBe(true)
    })
    it('un fichier que l’AUTRE contenu du jeu écrit aussi n’est pas retiré', async () => {
      const pkg = pkgFile(fullEntries); lay(pkg)
      const sibPkg = write(join(dir, 'autre.pkg'), makeFullPkg({ serial: SERIAL, entries: [{ name: 'USRDIR/data.dat', data: Buffer.from('donnees') }] }))
      await un(pkg, Date.now(), [item({ id: 2, path: sibPkg })])
      expect(existsSync(join(gameRoot(), SERIAL, 'USRDIR', 'data.dat'))).toBe(true)
      expect(existsSync(join(gameRoot(), SERIAL, 'USRDIR', 'EBOOT.BIN'))).toBe(false)
    })
    it('sans date d’installation, ou paquet illisible : rien n’est supprimé, le reste est signalé', async () => {
      const pkg = pkgFile(fullEntries); lay(pkg)
      expect((await un(pkg, null) as { leftover?: string }).leftover).toBe('RPCS3')
      expect((await un(write(join(dir, 'casse.pkg'), 'x'), Date.now()) as { leftover?: string }).leftover).toBe('RPCS3')
      expect(existsSync(join(gameRoot(), SERIAL, 'USRDIR', 'EBOOT.BIN'))).toBe(true)
    })
  })
})

// --- Cemu --------------------------------------------------------------------------------------------------------------------------------
describe('Cemu : identification, prérequis, installation par chemin de jeux', () => {
  const GAME_ID = '00050000101C9500', UPD = '0005000E101C9500', DLC = '0005000C101C9500'
  const emu = (): string => join(dir, 'cemu')
  const settings = (inner = '    <GamePaths/>'): string => `<?xml version="1.0"?>\n<content>\n    <logflag>0</logflag>\n${inner}\n    <GameCache/>\n</content>\n`
  const nus = (name: string, opt: { tik?: boolean; skipApp?: number } = {}): string => {
    const d = join(dir, 'src', name)
    write(join(d, 'title.tmd'), makeWiiUTmd(UPD, 16, [{ id: 0 }, { id: 1 }, { id: 2 }]))
    if (opt.tik !== false) write(join(d, 'title.tik'), 'ticket')
    for (const id of [0, 1, 2]) if (id !== opt.skipApp) write(join(d, `${id.toString(16).padStart(8, '0')}.app`))
    return d
  }
  const loadiine = (name: string, parts: { meta?: boolean; app?: boolean; cos?: boolean } = {}): string => {
    const d = join(dir, 'src', name)
    mkdirSync(join(d, 'content'), { recursive: true })
    if (parts.meta !== false) write(join(d, 'meta', 'meta.xml'), makeMetaXml(UPD, 16)); else mkdirSync(join(d, 'meta'), { recursive: true })
    if (parts.app !== false) write(join(d, 'code', 'app.xml'), makeAppXml(UPD, 16)); else mkdirSync(join(d, 'code'), { recursive: true })
    if (parts.cos !== false) write(join(d, 'code', 'cos.xml'), makeCosXml())
    return d
  }

  it('checkWiiUTitle : NUS complet, NUS sans ticket, NUS incomplet, dossier extrait complet / incomplet, dossier quelconque', async () => {
    expect(await checkWiiUTitle(nus('a'))).toEqual({ ok: true, format: 'nus' })
    expect(await checkWiiUTitle(nus('b', { tik: false }))).toMatchObject({ ok: false, reason: 'ticket' })
    expect(await checkWiiUTitle(nus('c', { skipApp: 2 }))).toMatchObject({ ok: false, reason: 'incomplete', detail: expect.stringContaining('00000002.app') })
    expect(await checkWiiUTitle(loadiine('d'))).toEqual({ ok: true, format: 'loadiine' })
    expect(await checkWiiUTitle(loadiine('e', { cos: false }))).toMatchObject({ ok: false, reason: 'incomplete' })
    expect(await checkWiiUTitle(loadiine('f', { meta: false }))).toMatchObject({ ok: false, reason: 'incomplete' })
    expect(await checkWiiUTitle(write(join(dir, 'src', 'g', 'x.txt')) && join(dir, 'src', 'g'))).toMatchObject({ ok: false, reason: 'invalid' })
  })
  it('settings.xml : ajoute le chemin (balise vide ou bloc existant), idempotent, entrées de l’utilisateur conservées', () => {
    const a = registerCemuGamePath(settings(), 'E:\\r\\wiiu\\.content')
    expect(a.changed).toBe(true)
    expect(cemuGamePaths(a.text)).toEqual(['E:/r/wiiu/.content'])
    expect(a.text).toContain('<GameCache/>')
    expect(registerCemuGamePath(a.text, 'e:/r/wiiu/.content/').changed).toBe(false)
    const user = settings('    <GamePaths>\n        <Entry>D:/mes jeux</Entry>\n    </GamePaths>')
    const b = registerCemuGamePath(user, 'E:/r/wiiu/.content')
    expect(cemuGamePaths(b.text)).toEqual(['D:/mes jeux', 'E:/r/wiiu/.content'])
    expect(registerCemuGamePath('<content></content>', 'E:/x').missing).toBe(true)
  })
  it('installation : le chemin est déclaré dans settings.xml, rien n’appartient à RomVault côté Cemu', async () => {
    write(join(emu(), 'settings.xml'), settings())
    const out = await cemuInstaller.install(env(emu(), false, 'Cemu.exe'), item({ path: nus('maj') }), game('wiiu', GAME_ID), 'import')
    expect(out).toEqual({ state: 'installed', emuFiles: [] })
    expect(cemuGamePaths(readFileSync(join(emu(), 'settings.xml'), 'utf8'))).toEqual([join(roms(), 'wiiu', '.content').replace(/\\/g, '/')])
    expect((await cemuInstaller.install(env(emu(), false, 'Cemu.exe'), item({ path: nus('maj') }), game('wiiu', GAME_ID), 'launch')).state).toBe('installed') // idempotent
  })
  it('titre NUS sans ticket : en attente d’une donnée utilisateur (jamais déclaré à Cemu, qui le refuserait)', async () => {
    write(join(emu(), 'settings.xml'), settings())
    const out = await cemuInstaller.install(env(emu(), false, 'Cemu.exe'), item({ path: nus('sans-tik', { tik: false }) }), game('wiiu', GAME_ID), 'import')
    expect(out).toMatchObject({ state: 'pending', reason: 'needsKey' })
    expect(cemuGamePaths(readFileSync(join(emu(), 'settings.xml'), 'utf8'))).toEqual([])
  })
  it('titre incomplet : en échec avec le fichier manquant précisé', async () => {
    write(join(emu(), 'settings.xml'), settings())
    const out = await cemuInstaller.install(env(emu(), false, 'Cemu.exe'), item({ path: nus('inc', { skipApp: 1 }) }), game('wiiu', GAME_ID), 'import')
    expect(out).toMatchObject({ state: 'failed' })
    expect(out.detail).toMatch(/00000001\.app/)
  })
  it('Cemu ouvert : settings.xml n’est pas modifié (il l’écraserait) ; configuration absente : en attente', async () => {
    write(join(emu(), 'settings.xml'), settings())
    expect(await cemuInstaller.install(env(emu(), true, 'Cemu.exe'), item({ path: loadiine('x') }), game('wiiu', GAME_ID), 'launch')).toMatchObject({ state: 'pending', reason: 'emulatorRunning' })
    expect(readFileSync(join(emu(), 'settings.xml'), 'utf8')).toBe(settings())
    rmSync(join(emu(), 'settings.xml'))
    expect(await cemuInstaller.install(env(emu(), false, 'Cemu.exe'), item({ path: loadiine('y') }), game('wiiu', GAME_ID), 'launch')).toMatchObject({ state: 'pending', reason: 'emulatorMissing' })
  })
  it('désinstallation : seul le titre rangé par RomVault est supprimé ; mlc01 (titres de l’utilisateur) n’est jamais touché', async () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    write(join(emu(), 'settings.xml'), settings())
    const mlc = write(join(emu(), 'mlc01', 'usr', 'title', '0005000e', '101c9500', 'meta', 'meta.xml'))
    saveEmulator(db, { id: 'cemu', version: 't', dir: emu(), exe: join(emu(), 'Cemu.exe'), custom: false })
    write(join(emu(), 'Cemu.exe'))
    db.prepare("INSERT INTO library (console, title, path, size, match, title_id, added_at) VALUES ('wiiu', 'J', ?, 1, 'name', ?, 1)").run(join(dir, 'j.wux'), GAME_ID)
    // Titre rangé tel que l'import le fait : dossier entier sous <roms>/wiiu/.content/<id du jeu>/.
    const stored = nus('range')
    const managed = join(roms(), 'wiiu', '.content', GAME_ID, 'maj')
    mkdirSync(dirname(managed), { recursive: true })
    cpSync(stored, managed, { recursive: true })
    db.prepare("INSERT INTO library_content (library_id, kind, title_id, version, label, path, size, added_at, state, emu_files) VALUES (1, 'update', ?, '16', 'maj', ?, 1, 1, 'installed', '[]')").run(UPD, managed)
    const r = await uninstallContent(db, 1, roms())
    expect(r.ok).toBe(true)
    expect(existsSync(managed)).toBe(false)
    expect(existsSync(mlc)).toBe(true)
    void DLC
  })
})

describe('Wii U — archives .wua (ZArchive)', () => {
  const B = '00050000101C9500', U = '0005000E101C9500', D = '0005000C101C9500'
  const wua = (name: string, titles: { titleId: string; version: number }[]): string => write(join(dir, 'src', name), makeWua(titles))
  it('lit les titres de l’archive sans la décompresser ; une archive qui n’en est pas une : null', async () => {
    expect(await readWuaTitles(wua('a.wua', [{ titleId: B, version: 0 }, { titleId: D, version: 80 }, { titleId: U, version: 208 }]))).toEqual([{ titleId: B, version: 0 }, { titleId: D, version: 80 }, { titleId: U, version: 208 }])
    expect(await readWuaTitles(write(join(dir, 'src', 'x.wua'), 'pas une archive'))).toBeNull()
  })
  it('jeu (avec ou sans sa mise à jour et ses DLC) = jeu ; mise à jour et/ou DLC seuls = contenu ; plusieurs jeux ou titre inconnu = unknown', async () => {
    expect(await probeWua(wua('b.wua', [{ titleId: B, version: 0 }, { titleId: U, version: 208 }]))).toMatchObject({ kind: 'base', baseKey: B })
    expect(await probeWua(wua('c.wua', [{ titleId: U, version: 208 }, { titleId: D, version: 80 }]))).toMatchObject({ kind: 'update', baseKey: B, version: '208' })
    expect(await probeWua(wua('d.wua', [{ titleId: D, version: 80 }]))).toMatchObject({ kind: 'dlc', baseKey: B })
    expect(await probeWua(wua('e.wua', [{ titleId: U, version: 1 }, { titleId: '0005000E101C9600', version: 1 }]))).toMatchObject({ kind: 'unknown' })
    expect(await probeWua(wua('f.wua', [{ titleId: '0005001010004000', version: 1 }]))).toMatchObject({ kind: 'unknown' })
  })
  it('import : un .wua de mise à jour seule n’est JAMAIS un jeu (en attente puis rattaché) ; un .wua de jeu est un jeu', async () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    const opt = (): Parameters<typeof importPaths>[2] => ({ copy: true, deleteSource: false, romsDir: roms(), logDir: join(dir, 'logs') })
    const upd = wua('maj.wua', [{ titleId: U, version: 208 }])
    expect((await importPaths(db, [upd], opt())).items[0].status).toBe('orphan')
    expect(listLibrary(db)).toHaveLength(0)
    const r = await importPaths(db, [wua('jeu.wua', [{ titleId: B, version: 0 }])], opt())
    expect(r.items[0].status).toBe('added')
    expect((db.prepare('SELECT title_id FROM library').get() as { title_id: string }).title_id).toBe(B)
    expect((db.prepare('SELECT COUNT(*) AS n FROM library_content').get() as { n: number }).n).toBe(1) // la mise à jour en attente a rejoint son jeu
  })
  it('readWuaFiles lit l’arborescence ; un titre Wii (vWii) emballé pour Wii U (frisbiiU.rpx, fw.img) n’est PAS un jeu importable (Cemu ne l’exécute pas : écran noir)', async () => {
    const T = `${B.toLowerCase()}_v0`
    const normal = write(join(dir, 'src', 'normal.wua'), makeWuaFiles([`${T}/code/app.xml`, `${T}/code/Game.rpx`, `${T}/content/data.bin`, `${T}/meta/meta.xml`]))
    const vwii = write(join(dir, 'src', 'vwii.wua'), makeWuaFiles([`${T}/code/app.xml`, `${T}/code/frisbiiU.rpx`, `${T}/code/fw.img`, `${T}/code/rvlt.tmd`, `${T}/content/hif_000000.nfs`, `${T}/meta/meta.xml`]))
    expect(await readWuaFiles(normal)).toEqual([`/${T}/code/app.xml`, `/${T}/code/Game.rpx`, `/${T}/content/data.bin`, `/${T}/meta/meta.xml`])
    expect(isVWiiWrapper((await readWuaFiles(normal))!)).toBe(false)
    expect(isVWiiWrapper((await readWuaFiles(vwii))!)).toBe(true)
    expect(await probeWua(normal)).toMatchObject({ kind: 'base', baseKey: B })
    expect(await probeWua(vwii)).toMatchObject({ kind: 'unknown', reason: VWII_REASON })
    const db = new DatabaseSync(':memory:'); migrate(db)
    const r = await importPaths(db, [vwii], { copy: true, deleteSource: false, romsDir: roms(), logDir: join(dir, 'logs') })
    expect(r.items[0]).toMatchObject({ status: 'error', error: VWII_REASON })
    expect(listLibrary(db)).toHaveLength(0)
  })
  it('checkWiiUTitle accepte une archive lisible', async () => {
    expect(await checkWiiUTitle(wua('g.wua', [{ titleId: U, version: 1 }]))).toEqual({ ok: true, format: 'wua' })
    expect(await checkWiiUTitle(write(join(dir, 'src', 'h.wua'), 'x'))).toMatchObject({ ok: false })
  })
})

// --- Vita3K ------------------------------------------------------------------------------------------------------------------------------
describe('Vita3K : identification des archives, installation avec sauvegarde, désinstallation', () => {
  const T = 'PCSE00097'
  const emu = (): string => join(dir, 'vita3k')
  const pref = (): string => join(dir, 'pref')
  const ux0 = (...p: string[]): string => join(pref(), 'ux0', ...p)
  beforeEach(() => { write(join(emu(), 'config.yml'), `pref-path: ${pref()}\n`) })
  const mk = (name: string, a: Buffer): string => write(join(dir, 'src', name), a)
  const DLC_CID = `EP0000-${T}_00-1234567890ABCDEF`

  /** Ce que Vita3K fait d'une archive (interface.cpp) : `ac` → addcont/<T>/<fin du CONTENT_ID> ; `gp` → fusion dans app/<T>. Écrit les octets réels de chaque entrée. */
  const runner = (category: 'gp' | 'ac', opts: { ok?: boolean; omit?: string[] } = {}): Vita3kRunners => ({
    archive: async (_exe, _cwd, archive) => {
      const info = (await readVitaArchive(archive)) as VitaArchiveInfo
      for (const e of info.entries) {
        if (opts.omit?.includes(e.name)) continue
        const bytes = Buffer.from((await readZipEntryText(archive, info.root + e.name)) ?? '', 'latin1')
        write(category === 'ac' ? ux0('addcont', T, DLC_CID.slice(20), ...e.name.split('/')) : ux0('app', T, ...e.name.split('/')), bytes)
      }
      return { ok: opts.ok ?? true, log: `[${T}] installed successfully!` }
    },
    pkg: async () => 0
  })
  const base = (): void => { write(ux0('app', T, 'eboot.bin'), 'ORIGINAL'); write(ux0('app', T, 'sce_sys', 'param.sfo'), 'sfo-original') }

  it('probeVitaArchive : jeu (gd) / mise à jour (gp) / DLC (ac) lus dans le PARAM.SFO ; racine en dossier ou à plat ; plusieurs contenus ou autre catégorie : unknown', async () => {
    expect(await probeVitaArchive(mk('g.zip', makeVitaArchive({ category: 'gd', titleId: T })))).toMatchObject({ console: 'vita', kind: 'base', baseKey: T })
    expect(await probeVitaArchive(mk('u.vpk', makeVitaArchive({ category: 'gp', titleId: T, version: '01.05' })))).toMatchObject({ kind: 'update', baseKey: T, version: '01.05' })
    expect(await probeVitaArchive(mk('d.zip', makeVitaArchive({ category: 'ac', titleId: T, contentId: DLC_CID, root: 'DLC1/' })))).toMatchObject({ kind: 'dlc', baseKey: T, titleId: DLC_CID })
    expect(await probeVitaArchive(mk('rom.zip', Buffer.from('PK pas une archive vita')))).toBeNull()
  })
  it('config.yml : pref-path lu, défaut sinon', async () => {
    expect(await vita3kPrefPath(emu())).toBe(pref())
    expect(await vita3kPrefPath(join(dir, 'nulle-part'))).toMatch(/Vita3K[\\/]Vita3K$/)
  })

  it('DLC : le dossier créé (et la licence) sont enregistrés ; la désinstallation les retire sans toucher au jeu', async () => {
    base()
    const arc = mk('dlc.zip', makeVitaArchive({ category: 'ac', titleId: T, contentId: DLC_CID, files: { 'data/a.pak': 'AAAA' } }))
    const inst = makeVita3kInstaller(runner('ac'))
    const out = await inst.install(env(emu()), item({ path: arc, kind: 'dlc' }), game('vita', T), 'launch')
    expect(out).toMatchObject({ state: 'installed' })
    expect(out.emuFiles).toEqual([ux0('addcont', T, DLC_CID.slice(20))])
    const un = await inst.uninstall!(env(emu()), [uref({ path: arc, kind: 'dlc', emuFiles: out.emuFiles })], game('vita', T))
    expect(un).toMatchObject({ ok: true })
    expect(existsSync(ux0('addcont', T, DLC_CID.slice(20)))).toBe(false)
    expect(existsSync(ux0('addcont', T))).toBe(false) // dossier parent devenu vide
    expect(readFileSync(ux0('app', T, 'eboot.bin'), 'utf8')).toBe('ORIGINAL')
  })
  it('mise à jour : l’original de chaque fichier écrasé est sauvegardé AVANT, enregistré, puis remis en place à la désinstallation', async () => {
    base()
    const arc = mk('maj.vpk', makeVitaArchive({ category: 'gp', titleId: T, version: '01.01', files: { 'eboot.bin': 'PATCHED', 'nouveau.dat': 'N' } }))
    const inst = makeVita3kInstaller(runner('gp'))
    const out = await inst.install(env(emu()), item({ id: 7, path: arc }), game('vita', T), 'launch')
    expect(out).toMatchObject({ state: 'installed' })
    expect(out.emuFiles).toEqual([ux0('app', T, 'nouveau.dat')])
    expect(Object.keys(out.emuBackups!).map((k) => k.toLowerCase()).sort()).toEqual([ux0('app', T, 'eboot.bin'), ux0('app', T, 'sce_sys', 'param.sfo')].map((s) => s.toLowerCase()).sort())
    expect(readFileSync(ux0('app', T, 'eboot.bin'), 'utf8')).toBe('PATCHED')
    const un = await inst.uninstall!(env(emu()), [uref({ id: 7, path: arc, emuFiles: out.emuFiles, emuBackups: out.emuBackups })], game('vita', T))
    expect(un).toMatchObject({ ok: true })
    expect(readFileSync(ux0('app', T, 'eboot.bin'), 'utf8')).toBe('ORIGINAL')
    expect(readFileSync(ux0('app', T, 'sce_sys', 'param.sfo'), 'utf8')).toBe('sfo-original')
    expect(existsSync(ux0('app', T, 'nouveau.dat'))).toBe(false)
    expect(existsSync(join(dir, 'content-backups', 'vita3k', '7'))).toBe(false)
  })
  it('mises à jour empilées : la plus ancienne ne peut pas être défaite avant la plus récente', async () => {
    base()
    const inst = makeVita3kInstaller(runner('gp'))
    const r = await inst.uninstall!(env(emu()), [uref({ id: 1, path: 'x', installedAt: 100, emuFiles: [], emuBackups: { [ux0('app', T, 'eboot.bin')]: write(join(dir, 'b', 'eboot.bin')) }, siblings: [item({ id: 2, kind: 'update', path: 'y', installedAt: 200 })] })], game('vita', T))
    expect(r).toMatchObject({ ok: false })
  })
  it('sauvegarde d’origine introuvable : désinstallation refusée AVANT toute modification', async () => {
    base()
    const inst = makeVita3kInstaller(runner('gp'))
    write(ux0('app', T, 'nouveau.dat'))
    const r = await inst.uninstall!(env(emu()), [uref({ path: 'x', emuFiles: [ux0('app', T, 'nouveau.dat')], emuBackups: { [ux0('app', T, 'eboot.bin')]: join(dir, 'disparue.bin') } })], game('vita', T))
    expect(r).toMatchObject({ ok: false })
    expect(existsSync(ux0('app', T, 'nouveau.dat'))).toBe(true)
  })
  it('installation partielle (un fichier de l’archive manque) : JAMAIS annoncée terminée', async () => {
    base()
    const arc = mk('dlc2.zip', makeVitaArchive({ category: 'ac', titleId: T, contentId: DLC_CID, files: { 'a.pak': 'AAAA', 'b.pak': 'BBBB' } }))
    const out = await makeVita3kInstaller(runner('ac', { omit: ['b.pak'] })).install(env(emu()), item({ path: arc, kind: 'dlc' }), game('vita', T), 'launch')
    expect(out.state).toBe('failed')
    expect(out.detail).toMatch(/b\.pak/)
  })
  it('Vita3K refuse : en échec, ce qui a été écrit est retiré et les originaux remis (le jeu n’est pas laissé à moitié mis à jour)', async () => {
    base()
    const arc = mk('maj2.vpk', makeVitaArchive({ category: 'gp', titleId: T, files: { 'eboot.bin': 'PATCHED', 'nouveau.dat': 'N' } }))
    const out = await makeVita3kInstaller(runner('gp', { ok: false })).install(env(emu()), item({ path: arc }), game('vita', T), 'launch')
    expect(out.state).toBe('failed')
    expect(readFileSync(ux0('app', T, 'eboot.bin'), 'utf8')).toBe('ORIGINAL')
    expect(existsSync(ux0('app', T, 'nouveau.dat'))).toBe(false)
  })
  it('archive d’un AUTRE jeu, jeu pas encore installé, plusieurs contenus : jamais installée', async () => {
    base()
    let ran = false
    const inst = makeVita3kInstaller({ archive: async () => { ran = true; return { ok: true, log: '' } }, pkg: async () => 0 })
    expect((await inst.install(env(emu()), item({ path: mk('x.vpk', makeVitaArchive({ category: 'gp', titleId: 'PCSE99999' })) }), game('vita', T), 'launch')).state).toBe('failed')
    rmSync(ux0('app'), { recursive: true, force: true })
    expect(await inst.install(env(emu()), item({ path: mk('y.vpk', makeVitaArchive({ category: 'gp', titleId: T })) }), game('vita', T), 'launch')).toMatchObject({ state: 'pending', reason: 'onLaunch' })
    expect((await inst.install(env(emu()), item({ path: mk('z.zip', makeZipStored([{ name: 'a/sce_sys/param.sfo', data: makeSfo({ CATEGORY: 'ac', TITLE_ID: T }) }, { name: 'b/sce_sys/param.sfo', data: makeSfo({ CATEGORY: 'ac', TITLE_ID: T }) }])) }), game('vita', T), 'launch')).state).toBe('failed')
    expect(ran).toBe(false)
  })
  it('à l’import rien n’est lancé (la fenêtre s’ouvrirait) ; Vita3K ouvert : en attente / refus', async () => {
    base()
    let ran = false
    const inst = makeVita3kInstaller({ archive: async () => { ran = true; return { ok: true, log: '' } }, pkg: async () => 0 })
    const arc = mk('u.vpk', makeVitaArchive({ category: 'gp', titleId: T }))
    expect(await inst.install(env(emu()), item({ path: arc }), game('vita', T), 'import')).toMatchObject({ reason: 'onLaunch' })
    expect(await inst.install(env(emu(), true), item({ path: arc }), game('vita', T), 'launch')).toMatchObject({ reason: 'emulatorRunning' })
    expect(await inst.uninstall!(env(emu(), true), [uref({ path: arc, emuFiles: [ux0('app', T, 'x')] })], game('vita', T))).toMatchObject({ ok: false })
    expect(ran).toBe(false)
  })
  it('un chemin enregistré hors de ux0 n’est jamais supprimé', async () => {
    const outside = write(join(dir, 'precieux.txt'))
    await makeVita3kInstaller(runner('ac')).uninstall!(env(emu()), [uref({ path: 'x', kind: 'dlc', emuFiles: [outside] })], game('vita', T))
    expect(existsSync(outside)).toBe(true)
  })

  describe('paquets .pkg', () => {
    const pkgBytes = (type: number): Buffer => { const b = Buffer.alloc(0x200); b.writeUInt32LE(0x474b507f, 0); b.writeUInt16BE(0x8000, 4); b.writeUInt16BE(2, 6); b.writeUInt32BE(0xc0, 8); b.writeUInt32BE(1, 0x0c); b.write(`EP0000-${T}_00-1234567890ABCDEF`, 0x30, 'latin1'); b.writeUInt32BE(2, 0xc0); b.writeUInt32BE(4, 0xc4); b.writeUInt32BE(type, 0xc8); return b }
    it('DLC avec le zRIF de l’utilisateur (fichier voisin) : installé, suivi ; sans zRIF : en attente de clé, rien n’est lancé', async () => {
      base()
      let zrifSeen = ''
      const inst = makeVita3kInstaller({ archive: async () => ({ ok: false, log: '' }), pkg: async (_e, _c, _p, z) => { zrifSeen = z; write(ux0('addcont', T, DLC_CID.slice(20), 'a.pak')); return 0 } })
      const pkg = write(join(dir, 'src', 'dlc.pkg'), pkgBytes(0x16))
      expect(await inst.install(env(emu()), item({ path: pkg, kind: 'dlc' }), game('vita', T), 'import')).toMatchObject({ state: 'pending', reason: 'needsKey' })
      expect(zrifSeen).toBe('')
      write(`${pkg}.zrif`, 'A'.repeat(40))
      const out = await inst.install(env(emu()), item({ path: pkg, kind: 'dlc' }), game('vita', T), 'import')
      expect(out).toMatchObject({ state: 'installed' })
      expect(out.emuFiles).toEqual([ux0('addcont', T, DLC_CID.slice(20))])
      expect(zrifSeen).toBe('A'.repeat(40))
    })
    it('mise à jour en .pkg : non installée (fusion dans le jeu sans moyen de la défaire), même avec un zRIF', async () => {
      base()
      let ran = false
      const inst = makeVita3kInstaller({ archive: async () => ({ ok: false, log: '' }), pkg: async () => { ran = true; return 0 } })
      const pkg = write(join(dir, 'src', 'maj.pkg'), pkgBytes(0x15)); write(`${pkg}.zrif`, 'A'.repeat(40))
      expect(await inst.install(env(emu()), item({ path: pkg }), game('vita', T), 'import')).toMatchObject({ state: 'pending', reason: 'unsupported' })
      expect(ran).toBe(false)
    })
    it('Vita3K se referme sans avoir créé le dossier du DLC : en échec', async () => {
      base()
      const inst = makeVita3kInstaller({ archive: async () => ({ ok: false, log: '' }), pkg: async () => 0 })
      const pkg = write(join(dir, 'src', 'dlc.pkg'), pkgBytes(0x16)); write(`${pkg}.zrif`, 'A'.repeat(40))
      expect((await inst.install(env(emu()), item({ path: pkg, kind: 'dlc' }), game('vita', T), 'import')).state).toBe('failed')
    })
  })
})

// --- Règles transversales de l'import ------------------------------------------------------------------------------------------------
describe('sécurité de l’import : un jeu n’est jamais un contenu, un contenu n’est jamais un jeu', () => {
  let db: DatabaseSync
  beforeEach(() => { db = new DatabaseSync(':memory:'); migrate(db) })
  const opt = (): Parameters<typeof importPaths>[2] => ({ copy: true, deleteSource: false, romsDir: roms(), logDir: join(dir, 'logs') })

  it('un jeu complet dont le NOM évoque une mise à jour ou un DLC reste un jeu (le conteneur décide, pas le nom)', async () => {
    const nsp = write(join(dir, 'src', 'Super Jeu Update DLC Pack.nsp'), nspWithXml('base', '0100000000010000'))
    const cia = write(join(dir, 'src', 'Autre DLC update.cia'), makeCia('0004000000030800'))
    const vita = write(join(dir, 'src', 'Vita update dlc.zip'), makeVitaArchive({ category: 'gd', titleId: 'PCSE00097', files: { 'eboot.bin': 'E' } }))
    const r = await importPaths(db, [nsp, cia, vita], opt())
    expect(r.items.map((i) => i.status)).toEqual(['added', 'added', 'added'])
    expect(listLibrary(db)).toHaveLength(3)
  })
  it('un DLC ou une mise à jour Vita (archive) n’est jamais une ligne de bibliothèque ; rattaché au jeu quand il est là, en attente sinon', async () => {
    const dlc = write(join(dir, 'src', 'dlc.zip'), makeVitaArchive({ category: 'ac', titleId: 'PCSE00097', contentId: 'EP0000-PCSE00097_00-1234567890ABCDEF', files: { 'a.pak': 'A' } }))
    expect((await importPaths(db, [dlc], opt())).items[0].status).toBe('orphan')
    expect(listLibrary(db)).toHaveLength(0)
    const g = write(join(dir, 'src', 'jeu.zip'), makeVitaArchive({ category: 'gd', titleId: 'PCSE00097', files: { 'eboot.bin': 'E' } }))
    await importPaths(db, [g], opt())
    expect(listLibrary(db)).toHaveLength(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM library_content').get() as { n: number }).n).toBe(1)
  })
  it('depuis la fiche d’un jeu : le contenu d’un AUTRE jeu est refusé (Vita et 3DS comme Switch)', async () => {
    await importPaths(db, [write(join(dir, 'src', 'a.zip'), makeVitaArchive({ category: 'gd', titleId: 'PCSE00097', files: { 'eboot.bin': 'E' } })), write(join(dir, 'src', 'b.cia'), makeCia('0004000000030800'))], opt())
    const id = (db.prepare("SELECT id FROM library WHERE console = 'vita'").get() as { id: number }).id
    const other = write(join(dir, 'src', 'autre-dlc.zip'), makeVitaArchive({ category: 'ac', titleId: 'PCSE55555', contentId: 'EP0000-PCSE55555_00-1234567890ABCDEF', files: { 'a.pak': 'A' } }))
    const threeDs = write(join(dir, 'src', 'upd.cia'), makeCia('0004000E00099900'))
    const r = await importPaths(db, [other, threeDs], { ...opt(), forGame: { id } })
    expect(r.items.map((i) => i.status)).toEqual(['error', 'error'])
    expect((db.prepare('SELECT COUNT(*) AS n FROM library_content').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM library_orphans').get() as { n: number }).n).toBe(0)
  })
})
