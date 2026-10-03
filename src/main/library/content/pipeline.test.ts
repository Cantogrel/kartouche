import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { migrate } from '../../db/migrations'
import { saveEmulator } from '../../emulators/emulatorStore'
import { installPendingContent } from '../../emulators/content'
import { edenConfigFile, edenContentDir, externalContentDirs, registerExternalDir } from '../../emulators/content/eden'
import { pkgVerdict } from '../../emulators/content/rpcs3'
import type { ContentInstaller } from '../../emulators/content/types'
import { importPaths } from '../importer'
import { listContent, listLibrary, removeEntry } from '../libraryStore'
import { makeCia, makeCnmtXml, makeMetaXml, makeNsp, makePkg, makeTik, makeTmd, nspWithTicket, nspWithXml } from './content.testutil'
import { parsePkgHeader } from './pkg'
import { deflateRawSync, crc32 } from 'node:zlib'

// Tests SYNTHÉTIQUES du pipeline mise à jour/DLC (analyse, ordre, rattachement, doublons, orphelins) : les fichiers sont fabriqués (content.testutil.ts).
// Ils valident la logique de RomVault, PAS la reconnaissance du contenu par un émulateur (voir switch.test.ts et real-eden.test.ts pour ce qui est réel).

const GAME_A = '0100000000010000', UPD_A = '0100000000010800', DLC_A1 = '0100000000011001', DLC_A2 = '0100000000011002'
const GAME_B = '0100000000020000', UPD_B = '0100000000020800', DLC_B1 = '0100000000021001'

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-content-')); db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const opt = (copy = true): Parameters<typeof importPaths>[2] => ({ copy, deleteSource: false, romsDir: join(dir, 'roms'), logDir: join(dir, 'logs') })
const put = (name: string, data: Buffer | string): string => { const p = join(dir, 'src', name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); return p }

/** Zip minimal à une entrée (méthode déflate). */
function zipOf(name: string, data: Buffer): Buffer {
  const comp = deflateRawSync(data), nm = Buffer.from(name), crc = crc32(data)
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26)
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28)
  const off = lh.length + nm.length + comp.length
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length + nm.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([lh, nm, comp, cd, nm, end])
}

const game = (id = GAME_A): string => put(`Game ${id}.nsp`, nspWithXml('base', id))
const update = (id = UPD_A, parent = GAME_A, v = 65536): string => put(`Update ${id} v${v}.nsp`, nspWithXml('update', id, v, parent))
const dlc = (id = DLC_A1, parent = GAME_A): string => put(`DLC ${id}.nsp`, nspWithXml('dlc', id, 0, parent))

const contentRows = (): { kind: string; title_id: string; version: string | null; state: string; reason: string | null; library_id: number }[] =>
  db.prepare('SELECT kind, title_id, version, state, reason, library_id FROM library_content ORDER BY id').all() as never
const orphanCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM library_orphans').get() as { n: number }).n

describe('jeu principal seul', () => {
  it('importé comme un jeu, avec son identifiant natif (clé de ses futurs contenus)', async () => {
    const r = await importPaths(db, [game()], opt())
    expect(r.items[0]).toMatchObject({ status: 'added', console: 'switch' })
    expect(listLibrary(db)).toHaveLength(1)
    expect(db.prepare('SELECT title_id FROM library').get()).toEqual({ title_id: GAME_A })
  })
})

describe('jeu + mises à jour + DLC', () => {
  it('jeu + mise à jour : rattachée, jamais une ligne de bibliothèque', async () => {
    const r = await importPaths(db, [game(), update()], opt())
    expect(r.items.map((i) => i.status).sort()).toEqual(['added', 'attached'])
    expect(listLibrary(db)).toHaveLength(1)
    expect(contentRows()).toMatchObject([{ kind: 'update', title_id: UPD_A, version: '65536' }])
  })
  it('jeu + DLC', async () => {
    await importPaths(db, [game(), dlc()], opt())
    expect(listLibrary(db)).toHaveLength(1)
    expect(contentRows()).toMatchObject([{ kind: 'dlc', title_id: DLC_A1 }])
  })
  it('jeu + mise à jour + plusieurs DLC', async () => {
    const r = await importPaths(db, [game(), update(), dlc(DLC_A1), dlc(DLC_A2)], opt())
    expect(r.items.filter((i) => i.status === 'attached')).toHaveLength(3)
    expect(listLibrary(db)).toHaveLength(1)
    expect(listContent(db, 1).map((c) => c.kind).sort()).toEqual(['dlc', 'dlc', 'update'])
  })
  it('DLC importé APRÈS le jeu (lots séparés)', async () => {
    await importPaths(db, [game()], opt())
    const r = await importPaths(db, [dlc()], opt())
    expect(r.items[0]).toMatchObject({ status: 'attached', contentKind: 'dlc' })
    expect(listLibrary(db)).toHaveLength(1)
  })
  it('DLC importé AVANT le jeu (lots séparés) : mis en attente, puis rattaché tout seul à l’arrivée du jeu', async () => {
    const r1 = await importPaths(db, [dlc(), update()], opt())
    expect(r1.items.map((i) => i.status)).toEqual(['orphan', 'orphan'])
    expect(listLibrary(db)).toHaveLength(0) // jamais un faux jeu
    expect(orphanCount()).toBe(2)
    await importPaths(db, [game()], opt())
    expect(listLibrary(db)).toHaveLength(1)
    expect(orphanCount()).toBe(0)
    expect(contentRows().map((c) => c.kind).sort()).toEqual(['dlc', 'update'])
  })
  it.each([[0], [1], [2], [3], [4], [5]])('ordre arbitraire dans un même lot (permutation %i)', async (n) => {
    const all = [dlc(DLC_A1), update(), game()]
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    await importPaths(db, perms[n].map((i) => all[i]), opt())
    expect(listLibrary(db)).toHaveLength(1)
    expect(contentRows()).toHaveLength(2)
  })
  it('plusieurs jeux et leurs contenus mélangés : chacun rejoint SON jeu', async () => {
    await importPaths(db, [dlc(DLC_B1, GAME_B), update(UPD_A, GAME_A), game(GAME_B), dlc(DLC_A1, GAME_A), update(UPD_B, GAME_B), game(GAME_A)], opt())
    expect(listLibrary(db)).toHaveLength(2)
    const byGame = new Map((db.prepare('SELECT id, title_id FROM library').all() as { id: number; title_id: string }[]).map((r) => [r.title_id, r.id]))
    const kinds = (id: number): string[] => listContent(db, id).map((c) => `${c.kind}:${c.titleId}`).sort()
    expect(kinds(byGame.get(GAME_A)!)).toEqual([`dlc:${DLC_A1}`, `update:${UPD_A}`])
    expect(kinds(byGame.get(GAME_B)!)).toEqual([`dlc:${DLC_B1}`, `update:${UPD_B}`])
  })
})

describe('sans jeu parent, doublons, contenu mal identifié', () => {
  it('DLC sans jeu parent : ni jeu, ni perte — en attente, tracé dans le journal', async () => {
    const f = dlc()
    const r = await importPaths(db, [f], opt())
    expect(r.items[0]).toMatchObject({ status: 'orphan' })
    expect(listLibrary(db)).toHaveLength(0)
    expect(orphanCount()).toBe(1)
    expect(readFileSync(join(dir, 'logs', 'content.log'), 'utf8')).toContain(GAME_A)
    expect(existsSync(f)).toBe(true) // l'original n'est jamais supprimé (deleteSource désactivé)
  })
  it('mise à jour sans jeu parent : idem', async () => {
    const r = await importPaths(db, [update()], opt())
    expect(r.items[0].status).toBe('orphan')
    expect(listLibrary(db)).toHaveLength(0)
  })
  it('un jeu d’un AUTRE titre n’adopte pas un contenu qui n’est pas le sien', async () => {
    await importPaths(db, [dlc(DLC_A1, GAME_A)], opt())
    await importPaths(db, [game(GAME_B)], opt())
    expect(orphanCount()).toBe(1)
    expect(contentRows()).toHaveLength(0)
  })
  it('contenu déjà installé : second import = doublon, aucune seconde ligne', async () => {
    const [g, u] = [game(), update()]
    await importPaths(db, [g, u], opt())
    const r = await importPaths(db, [g, u], opt())
    expect(r.items.map((i) => i.status).sort()).toEqual(['duplicate', 'duplicate'])
    expect(contentRows()).toHaveLength(1)
    expect(listLibrary(db)).toHaveLength(1)
  })
  it('même mise à jour (même identifiant et version) sous un autre nom de fichier : doublon', async () => {
    await importPaths(db, [game(), update()], opt())
    const copy = put('Autre nom.nsp', nspWithXml('update', UPD_A, 65536, GAME_A, 'autre contenu'))
    expect((await importPaths(db, [copy], opt())).items[0].status).toBe('duplicate')
    expect(contentRows()).toHaveLength(1)
  })
  it('une nouvelle version de la mise à jour s’ajoute (Eden gère plusieurs versions)', async () => {
    await importPaths(db, [game(), update(UPD_A, GAME_A, 65536)], opt())
    await importPaths(db, [update(UPD_A, GAME_A, 131072)], opt())
    expect(contentRows().map((c) => c.version)).toEqual(['65536', '131072'])
  })
  it('contenu mal identifié (ticket et XML qui se contredisent) : refusé, fichier intact, jamais un jeu', async () => {
    const f = put('Contradictoire.nsp', makeNsp([
      { name: 'x.cnmt.xml', data: makeCnmtXml('update', UPD_A, 1, GAME_A) },
      { name: 'y.tik', data: makeTik(UPD_B) },
      { name: 'z.nca', data: Buffer.from('x') }
    ]))
    const r = await importPaths(db, [f], opt())
    expect(r.items[0].status).toBe('error')
    expect(r.items[0].error).toMatch(/contradictoires/)
    expect(listLibrary(db)).toHaveLength(0)
    expect(orphanCount()).toBe(0)
    expect(existsSync(f)).toBe(true)
  })
  it('nom évoquant une mise à jour, mais fichier illisible et sans identifiant : refusé, jamais un jeu', async () => {
    const f = put('Super Smash Bros. Ultimate Switch NSP Update v2031616.nsp', 'pas un nsp')
    const r = await importPaths(db, [f], opt())
    expect(r.items[0].status).toBe('error')
    expect(listLibrary(db)).toHaveLength(0)
    expect(existsSync(f)).toBe(true)
  })
  it('identifié par le seul ticket (aucun XML) : accepté, parent déduit de la règle de Title ID d’Eden', async () => {
    await importPaths(db, [game()], opt())
    const t = put('Ticket seul.nsp', nspWithTicket(DLC_A1))
    expect((await importPaths(db, [t], opt())).items[0]).toMatchObject({ status: 'attached', contentKind: 'dlc' })
  })
  it('un contenu n’est JAMAIS une ligne de la bibliothèque, quel que soit le lot', async () => {
    await importPaths(db, [update(), dlc(), game(GAME_B), game(), update(UPD_B, GAME_B), dlc(DLC_A2)], opt())
    expect(listLibrary(db).map((e) => e.console)).toEqual(['switch', 'switch'])
    expect(listLibrary(db)).toHaveLength(2)
  })
})

describe('rangement et suppression', () => {
  it('mode copie : le contenu est rangé sous <roms>/switch/.content/<jeu>/ ; supprimé avec le jeu', async () => {
    await importPaths(db, [game(), update()], opt(true))
    const row = db.prepare('SELECT path FROM library_content').get() as { path: string }
    expect(row.path).toBe(join(dir, 'roms', 'switch', '.content', GAME_A, `Update ${UPD_A} v65536.nsp`))
    expect(existsSync(row.path)).toBe(true)
    await removeEntry(db, 1, 'all', join(dir, 'saves'), join(dir, 'roms'))
    expect(existsSync(row.path)).toBe(false)
    expect(contentRows()).toHaveLength(0)
  })
  it('mode « ne pas copier » : Eden lit un dossier géré, le contenu y est donc relié (lien physique ou copie)', async () => {
    const u = update()
    await importPaths(db, [game(), u], opt(false))
    const row = db.prepare('SELECT path FROM library_content').get() as { path: string }
    expect(row.path.startsWith(join(dir, 'roms', 'switch', '.content'))).toBe(true)
    expect(existsSync(u)).toBe(true)
  })
})

// --- Eden : déclaration du dossier de contenu externe ---------------------------------------------------------------------------------
describe('Eden — dossier de contenu externe (qt-config.ini)', () => {
  const base = '[UI]\nPaths\\gamedirs\\size=0\nPaths\\external_content_dirs\\size=0\nsingleWindowMode=true\n\n[Audio]\nvolume=100\n'
  it('ajoute le dossier, sans toucher au reste', () => {
    const { text, changed } = registerExternalDir(base, 'E:\\dev\\roms\\switch\\.content')
    expect(changed).toBe(true)
    expect(text).toContain('Paths\\external_content_dirs\\size=1')
    expect(text).toContain('Paths\\external_content_dirs\\1\\path=E:/dev/roms/switch/.content/')
    expect(text).toContain('[Audio]\nvolume=100')
    expect(externalContentDirs(text)).toEqual(['E:/dev/roms/switch/.content/'])
  })
  it('idempotent, y compris si Eden a réécrit l’entrée avec des barres inverses doublées', () => {
    const once = registerExternalDir(base, 'E:\\dev\\roms\\switch\\.content').text
    expect(registerExternalDir(once, 'E:\\dev\\roms\\switch\\.content').changed).toBe(false)
    const eden = base.replace('size=0\nsingleWindowMode', 'size=1\nPaths\\external_content_dirs\\1\\path=E:\\\\dev\\\\roms\\\\switch\\\\.content\\\\\nsingleWindowMode')
    expect(registerExternalDir(eden, 'E:\\dev\\roms\\switch\\.content').changed).toBe(false)
  })
  it('conserve les dossiers de l’utilisateur et ajoute le sien à la suite', () => {
    const user = base.replace('size=0\nsingleWindowMode', 'size=1\nPaths\\external_content_dirs\\1\\path=D:\\\\mes dlc\\\\\nsingleWindowMode')
    const { text } = registerExternalDir(user, 'E:\\r\\switch\\.content')
    expect(text).toContain('Paths\\external_content_dirs\\size=2')
    expect(text).toContain('D:\\\\mes dlc\\\\')
    expect(externalContentDirs(text)).toHaveLength(2)
  })
  it('fichier de configuration absent : section [UI] créée', () => {
    expect(registerExternalDir('', 'E:\\r\\switch\\.content').text).toContain('[UI]')
  })

  const setupEden = (): { cfg: string } => {
    const edenDir = join(dir, 'eden')
    mkdirSync(join(edenDir, 'user', 'config'), { recursive: true })
    writeFileSync(join(edenDir, 'eden.exe'), 'x')
    writeFileSync(edenConfigFile(edenDir), base)
    saveEmulator(db, { id: 'eden', version: 'test', dir: edenDir, exe: join(edenDir, 'eden.exe'), custom: false })
    return { cfg: edenConfigFile(edenDir) }
  }
  it('à l’import : le dossier est déclaré à Eden et le contenu passe « installé »', async () => {
    const { cfg } = setupEden()
    await importPaths(db, [game(), update()], opt())
    expect(contentRows()[0]).toMatchObject({ state: 'installed' })
    expect(readFileSync(cfg, 'utf8')).toContain(edenContentDir(join(dir, 'roms')).replace(/\\/g, '/'))
  })
  it('Eden en cours d’exécution : rien n’est écrit, le contenu reste en attente (retenté au lancement)', async () => {
    const { cfg } = setupEden()
    await importPaths(db, [game()], opt())
    await importPaths(db, [update()], { ...opt() }) // installe (Eden n'est pas lancé dans ce test)
    writeFileSync(cfg, base) // simule un qt-config sans notre dossier, Eden « lancé »
    db.prepare("UPDATE library_content SET state = 'pending', reason = NULL").run()
    await installPendingContent(db, 1, join(dir, 'roms'), 'launch', { env: { isRunning: async () => true } })
    expect(contentRows()[0]).toMatchObject({ state: 'pending', reason: 'emulatorRunning' })
    expect(readFileSync(cfg, 'utf8')).toBe(base)
    await installPendingContent(db, 1, join(dir, 'roms'), 'launch', { env: { isRunning: async () => false } })
    expect(contentRows()[0]).toMatchObject({ state: 'installed' })
  })
  it('Eden pas encore installé : en attente (emulatorMissing), jamais perdu', async () => {
    await importPaths(db, [game(), update()], opt())
    expect(contentRows()[0]).toMatchObject({ state: 'pending', reason: 'emulatorMissing' })
  })
})

// --- 3DS (Azahar) -----------------------------------------------------------------------------------------------------------------------
describe('3DS — .cia', () => {
  const GAME = '0004000000030800', UPD = '0004000E00030800', DLC = '0004008C00030800'
  it('jeu, mise à jour et DLC .cia : rattachés (même identifiant bas), installation reportée au lancement', async () => {
    writeFileSync(join(dir, 'azahar.exe'), 'x')
    saveEmulator(db, { id: 'azahar', version: 't', dir, exe: join(dir, 'azahar.exe'), custom: false })
    const files = [put('dlc.cia', makeCia(DLC, 0)), put('update.cia', makeCia(UPD, 1 << 10)), put('game.cia', makeCia(GAME))]
    const r = await importPaths(db, files, opt())
    expect(listLibrary(db)).toHaveLength(1)
    expect(r.items.map((i) => i.status).sort()).toEqual(['added', 'attached', 'attached'])
    expect(db.prepare('SELECT title_id FROM library').get()).toEqual({ title_id: GAME })
    expect(contentRows().map((c) => [c.kind, c.version, c.state, c.reason]).sort()).toEqual([['dlc', '0.0.0', 'pending', 'onLaunch'], ['update', '1.0.0', 'pending', 'onLaunch']].sort())
  })
  it('au lancement : l’installateur Azahar est appelé pour chaque contenu en attente, une seule fois', async () => {
    await importPaths(db, [put('game.cia', makeCia(GAME)), put('update.cia', makeCia(UPD))], opt())
    const calls: string[] = []
    const fake: ContentInstaller = { emulatorId: 'azahar', managed: false, install: async (_e, item, _g, when) => { calls.push(`${item.kind}:${when}`); return { state: 'installed' } } }
    await installPendingContent(db, 1, join(dir, 'roms'), 'launch', { installers: { n3ds: fake } })
    await installPendingContent(db, 1, join(dir, 'roms'), 'launch', { installers: { n3ds: fake } })
    expect(calls).toEqual(['update:launch'])
    expect(contentRows()[0].state).toBe('installed')
  })
  it('contenu 3DS hors périmètre (démo 00040002) : refusé, jamais rattaché ni importé comme jeu', async () => {
    const r = await importPaths(db, [put('demo.cia', makeCia('0004000200030800'))], opt())
    expect(r.items[0]).toMatchObject({ status: 'error' })
    expect(listLibrary(db)).toHaveLength(0)
  })
  it('DLC dont le jeu parent a un autre identifiant : en attente, pas rattaché au mauvais jeu', async () => {
    await importPaths(db, [put('game.cia', makeCia(GAME))], opt())
    const r = await importPaths(db, [put('dlc2.cia', makeCia('0004008C00099900'))], opt())
    expect(r.items[0].status).toBe('orphan')
    expect(contentRows()).toHaveLength(0)
  })
})

// --- PS3 (RPCS3), Vita (Vita3K), Wii U (Cemu) : fichiers synthétiques, jeu de base inséré à la main -----------------------------------------
const addGame = (consoleId: string, titleId: string, path = join(dir, 'game.bin')): number => {
  writeFileSync(path, 'jeu')
  return Number(db.prepare('INSERT INTO library (console, title, path, size, match, title_id, added_at) VALUES (?, ?, ?, 3, \'none\', ?, 1)').run(consoleId, `Jeu ${titleId}`, path, titleId).lastInsertRowid)
}

describe('PS3 — .pkg', () => {
  it('en-tête : numéro de série, type et drapeaux comme RPCS3 les lit', () => {
    expect(parsePkgHeader(makePkg({ platform: 1, serial: 'BLUS30443', contentType: 4, flags: 0x10 }))).toMatchObject({ platform: 1, serial: 'BLUS30443', contentType: 4, flags: 0x10 })
  })
  it('mise à jour (Game Data + drapeau PATCH) et DLC (Game Data) rattachés au jeu de même numéro de série ; installés par RPCS3', async () => {
    const id = addGame('ps3', 'BLUS30443')
    const r = await importPaths(db, [put('patch.pkg', makePkg({ platform: 1, serial: 'BLUS30443', contentType: 4, flags: 0x10 })), put('dlc.pkg', makePkg({ platform: 1, serial: 'BLUS30443', contentType: 4 }))], opt())
    expect(r.items.map((i) => i.status)).toEqual(['attached', 'attached'])
    expect(listContent(db, id).map((c) => c.kind).sort()).toEqual(['dlc', 'update'])
    expect(listLibrary(db)).toHaveLength(1)
    // RPCS3 absent de cette machine de test : en attente, pas en échec.
    expect(listContent(db, id)[0]).toMatchObject({ state: 'pending', reason: 'emulatorMissing' })
  })
  it('PKG d’un autre jeu : orphelin ; PKG de jeu complet (PSN) : refusé, jamais importé', async () => {
    addGame('ps3', 'BLUS30443')
    const r = await importPaths(db, [put('autre.pkg', makePkg({ platform: 1, serial: 'BLES00001', contentType: 4 })), put('jeu.pkg', makePkg({ platform: 1, serial: 'NPUB30001', contentType: 5 })), put('vide.pkg', 'rien')], opt())
    expect(r.items.map((i) => i.status).sort()).toEqual(['error', 'error', 'orphan'])
    expect(listLibrary(db)).toHaveLength(1)
  })
  it('verdict de RPCS3 lu dans son journal', () => {
    expect(pkgVerdict('·· Successfully installed C:\\x\\patch.pkg (title_id=BLUS30443)', 'D:\\y\\patch.pkg')).toBe('ok')
    expect(pkgVerdict('Failed to install C:\\x\\patch.pkg (title_id=B)', 'patch.pkg')).toBe('failed')
    expect(pkgVerdict('rien', 'patch.pkg')).toBe('unknown')
  })
})

describe('« .nsp » qui n’est pas un titre Switch (ex. exefs.nsp de emuiibo)', () => {
  const exefs = makeNsp([{ name: 'main', data: Buffer.from('code') }, { name: 'main.npdm', data: Buffer.from('npdm') }])
  it('refusé tel quel, jamais un jeu', async () => {
    const r = await importPaths(db, [put('exefs.nsp', exefs)], opt())
    expect(r.items[0].status).toBe('error')
    expect(r.items[0].error).toMatch(/aucun NCA/)
    expect(listLibrary(db)).toHaveLength(0)
  })
  it('refusé aussi dans un .zip (cas réel : emuiibo-v0.6.3.zip), l’archive reste intacte', async () => {
    const zip = put('emuiibo.zip', zipOf('SdOut/atmosphere/contents/0100000000000352/exefs.nsp', exefs))
    const r = await importPaths(db, [zip], opt())
    expect(r.items[0].status).toBe('error')
    expect(listLibrary(db)).toHaveLength(0)
    expect(existsSync(zip)).toBe(true)
  })
})

describe('archives', () => {
  it('mise à jour Switch dans un .zip (illisible sans extraction) : refusée par son nom, jamais un jeu', async () => {
    const zip = put('Jeu [0100000000010800][v1].zip', zipOf('Jeu [0100000000010800][v1].nsp', Buffer.from('x')))
    const r = await importPaths(db, [zip], opt())
    expect(r.items[0].status).toBe('error')
    expect(listLibrary(db)).toHaveLength(0)
  })
})

describe('.pkg hors périmètre trouvés dans un dossier', () => {
  it('ignorés sans bruit (ni erreur, ni jeu) ; choisis un à un, ils sont refusés explicitement', async () => {
    addGame('ps3', 'BLUS30443')
    put('lot/psp.pkg', makePkg({ platform: 2, serial: 'ULUS10041', contentType: 0x07 }))
    put('lot/psn.pkg', makePkg({ platform: 1, serial: 'NPUB30001', contentType: 5 }))
    put('lot/cassé.pkg', 'rien')
    const r = await importPaths(db, [join(dir, 'src', 'lot')], opt())
    expect(r.items).toHaveLength(0)
    expect(r.ignored).toBe(3)
    expect((await importPaths(db, [join(dir, 'src', 'lot', 'psn.pkg')], opt())).items[0].status).toBe('error')
  })
})

describe('Vita — .pkg (zRIF requis, jamais inventé)', () => {
  it('DLC identifié, rattaché au jeu, conservé « clé requise » ; jamais un jeu', async () => {
    const id = addGame('vita', 'PCSE00097')
    const r = await importPaths(db, [put('dlc.pkg', makePkg({ platform: 2, serial: 'PCSE00097', contentType: 0x16 }))], opt())
    expect(r.items[0]).toMatchObject({ status: 'attached', contentKind: 'dlc' })
    expect(listLibrary(db)).toHaveLength(1)
    expect(listContent(db, id)[0]).toMatchObject({ kind: 'dlc', needs: 'license' })
  })
  it('installation : en attente de clé (le gestionnaire ne devine ni ne télécharge rien)', async () => {
    const id = addGame('vita', 'PCSE00097')
    writeFileSync(join(dir, 'vita3k.exe'), 'x')
    saveEmulator(db, { id: 'vita3k', version: 't', dir, exe: join(dir, 'vita3k.exe'), custom: false })
    await importPaths(db, [put('dlc.pkg', makePkg({ platform: 2, serial: 'PCSE00097', contentType: 0x16 }))], opt())
    expect(listContent(db, id)[0]).toMatchObject({ state: 'pending', reason: 'needsKey' })
  })
  it('paquet Vita ni DLC ni mise à jour identifiable : refusé', async () => {
    addGame('vita', 'PCSE00097')
    expect((await importPaths(db, [put('app.pkg', makePkg({ platform: 2, serial: 'PCSE00097', contentType: 0x15 }))], opt())).items[0].status).toBe('error')
  })
})

describe('Wii U — dossiers de titre', () => {
  const GAME = '00050000101C9500', UPD = '0005000E101C9500', DLC = '0005000C101C9500'
  const folder = (name: string, files: Record<string, string | Buffer>): string => {
    for (const [f, data] of Object.entries(files)) { mkdirSync(join(dir, 'src', name, f, '..'), { recursive: true }); writeFileSync(join(dir, 'src', name, f), data) }
    return join(dir, 'src', name)
  }
  it('mise à jour et DLC (meta.xml ou title.tmd) : rattachés au jeu de même identifiant bas, installation « pas encore prise en charge »', async () => {
    const id = addGame('wiiu', GAME)
    const u = folder('upd', { 'meta/meta.xml': makeMetaXml(UPD, 16), 'code/app.rpx': 'x' })
    const d = folder('dlc', { 'title.tmd': makeTmd(DLC, 3), '00000000.app': 'x' })
    const r = await importPaths(db, [u, d], opt())
    expect(r.items.map((i) => i.status)).toEqual(['attached', 'attached'])
    expect(listLibrary(db)).toHaveLength(1)
    expect(listContent(db, id).map((c) => c.kind).sort()).toEqual(['dlc', 'update'])
    expect(listContent(db, id)[0]).toMatchObject({ state: 'pending' })
  })
  it('un dossier trouvé dans un dossier parent est reconnu aussi ; un dossier de jeu de base est ignoré comme avant', async () => {
    const id = addGame('wiiu', GAME)
    folder('lot/upd', { 'meta/meta.xml': makeMetaXml(UPD) })
    folder('lot/base', { 'meta/meta.xml': makeMetaXml(GAME), 'content/0000.app': 'x' })
    const r = await importPaths(db, [join(dir, 'src', 'lot')], opt())
    expect(r.items.filter((i) => i.status === 'attached')).toHaveLength(1)
    expect(listContent(db, id)).toHaveLength(1)
    expect(listLibrary(db)).toHaveLength(1)
  })
  it('mise à jour Wii U sans jeu parent : orphelin', async () => {
    const r = await importPaths(db, [folder('upd2', { 'meta/meta.xml': makeMetaXml(UPD) })], opt())
    expect(r.items[0].status).toBe('orphan')
    expect(listLibrary(db)).toHaveLength(0)
  })
})

describe('jeu importé AVANT cette fonctionnalité (sans identifiant mémorisé)', () => {
  it('son identifiant est lu dans son fichier au moment de rattacher un DLC, puis mémorisé', async () => {
    const path = put('vieux jeu.nsp', nspWithXml('base', GAME_A))
    db.prepare('INSERT INTO library (console, title, path, size, match, added_at) VALUES (\'switch\', \'Vieux jeu\', ?, 1, \'name\', 1)').run(path)
    const r = await importPaths(db, [dlc()], opt())
    expect(r.items[0].status).toBe('attached')
    expect(db.prepare('SELECT title_id FROM library').get()).toEqual({ title_id: GAME_A })
  })
  it('réimporter le jeu déjà présent (doublon) mémorise son identifiant et rattache les contenus qui l’attendaient', async () => {
    const g = game()
    db.prepare('INSERT INTO library (console, title, path, size, match, added_at) VALUES (\'switch\', \'Jeu\', ?, 1, \'name\', 1)').run(g)
    db.prepare("INSERT INTO library_orphans (console, base_key, kind, title_id, version, label, path, size, source, added_at) VALUES ('switch', ?, 'dlc', ?, '0', 'x', ?, 1, 'container', 1)").run(GAME_A, DLC_A1, g)
    await importPaths(db, [g], opt(false))
    expect(contentRows()).toHaveLength(1)
  })
})
