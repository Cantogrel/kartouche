import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import { saveEmulator } from '../emulators/emulatorStore'
import { makeCso, makeSfo, miniIso, toRawSectors } from '../emulators/testImages'
import { backupSaves, cemuMlcDir, deleteGameSaves, learnCemuKey, restoreSaves, saveInfo, saveOpenTarget, snapshotCemuSaves } from './saves'

// Chaque jeu ne voit, ne copie, ne restaure et ne supprime que ses propres sauvegardes, pour tous les émulateurs.

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-pg-')); db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const saves = (): string => join(dir, 'saves')
const install = (id: string): string => { const d = join(dir, id); mkdirSync(d, { recursive: true }); saveEmulator(db, { id, version: '1', dir: d, exe: join(d, 'e.exe'), custom: false }); return d }
const put = (...parts: string[]): string => {
  mkdirSync(join(...parts.slice(0, -2)), { recursive: true })
  const p = join(...parts.slice(0, -1))
  writeFileSync(p, parts[parts.length - 1])
  return p
}
const entry = (id: number, console: string, gameKey: string | null, path = `x${id}.rom`): { id: number; console: string; path: string; gameKey: string | null } => ({ id, console, path, gameKey })
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')

describe('Cemu : saves par Title ID', () => {
  const A = '0005000010143600', B = '000500001019E600'
  const dirOf = (emu: string, tid: string): string => join(emu, 'mlc01', 'usr', 'save', tid.slice(0, 8).toLowerCase(), tid.slice(8).toLowerCase())
  it('chaque jeu ne voit que son dossier ; « system » (comptes, journal de jeu) n\'est à aucun jeu', async () => {
    const emu = install('cemu')
    put(dirOf(emu, A), 'user', '80000001', 'slot0', 'a1')
    put(dirOf(emu, B), 'user', '80000001', 'slot0', 'b1')
    put(emu, 'mlc01', 'usr', 'save', 'system', 'act', 'account.dat', 'x')
    const a = await saveInfo(db, saves(), entry(1, 'wiiu', A)), b = await saveInfo(db, saves(), entry(2, 'wiiu', B))
    expect(a).toMatchObject({ emulator: 'cemu', scope: 'game', files: 1 })
    expect(b).toMatchObject({ emulator: 'cemu', scope: 'game', files: 1 })
    await backupSaves(db, saves(), entry(1, 'wiiu', A))
    // La copie du jeu A ne contient rien du jeu B ni du système.
    rmSync(dirOf(emu, A), { recursive: true })
    expect(await restoreSaves(db, saves(), entry(1, 'wiiu', A), (await saveInfo(db, saves(), entry(1, 'wiiu', A)))!.backups[0].name)).toBe(true)
    expect(read(dirOf(emu, A), 'user', '80000001', 'slot0')).toBe('a1')
    expect(existsSync(join(emu, 'mlc01', 'usr', 'save', 'system', 'act', 'account.dat'))).toBe(true)
  })
  it('restaure au bon endroit même si le dossier du jeu a disparu', async () => {
    const emu = install('cemu')
    put(dirOf(emu, A), 'user', 'common', 'opt', 'o')
    const b = await backupSaves(db, saves(), entry(1, 'wiiu', A))
    rmSync(join(emu, 'mlc01'), { recursive: true })
    await restoreSaves(db, saves(), entry(1, 'wiiu', A), b!.name)
    expect(read(dirOf(emu, A), 'user', 'common', 'opt')).toBe('o')
  })
  it('supprime la sauvegarde d\'un jeu sans toucher à celle d\'un autre', async () => {
    const emu = install('cemu')
    put(dirOf(emu, A), 'user', 'a')
    put(dirOf(emu, B), 'user', 'b')
    await deleteGameSaves(db, saves(), entry(1, 'wiiu', A))
    expect(existsSync(dirOf(emu, A))).toBe(false)
    expect(existsSync(dirOf(emu, B))).toBe(true)
  })
  it('jeu jamais lancé : aucune sauvegarde (pas celle de l\'émulateur entier)', async () => {
    const emu = install('cemu')
    put(dirOf(emu, B), 'user', 'b')
    expect(await saveInfo(db, saves(), entry(1, 'wiiu', A))).toMatchObject({ scope: 'game', files: 0 })
  })
  it('suit le dossier mlc01 choisi dans settings.xml', async () => {
    const emu = install('cemu')
    const elsewhere = join(dir, 'ailleurs')
    writeFileSync(join(emu, 'settings.xml'), `<content><mlc_path>${elsewhere}</mlc_path></content>`)
    expect(await cemuMlcDir(emu)).toBe(elsewhere)
    put(elsewhere, 'usr', 'save', A.slice(0, 8).toLowerCase(), A.slice(8).toLowerCase(), 'user', 'a')
    expect(await saveInfo(db, saves(), entry(1, 'wiiu', A))).toMatchObject({ files: 1 })
    expect((await saveOpenTarget(db, saves(), entry(1, 'wiiu', A)))?.path).toContain('ailleurs')
  })
  it('Title ID appris de la partie : le seul dossier touché, jamais « system », jamais ambigu', async () => {
    const emu = install('cemu')
    db.prepare("INSERT INTO library (id, console, title, path, size, match, added_at) VALUES (1, 'wiiu', 'Jeu', 'x.zip', 1, 'name', 1)").run()
    const mlc = join(emu, 'mlc01')
    put(dirOf(emu, B), 'user', 'b')
    const before = await snapshotCemuSaves(mlc)
    put(dirOf(emu, A), 'user', 'a')
    put(emu, 'mlc01', 'usr', 'save', 'system', 'pdm', 'x', 'y')
    expect(await learnCemuKey(db, 1, mlc, before)).toBe(A)
    expect((db.prepare('SELECT game_key FROM library WHERE id = 1').get() as { game_key: string }).game_key).toBe(A)
    // Deux dossiers touchés pendant la même partie : on ne choisit pas.
    const snap = await snapshotCemuSaves(mlc)
    const future = new Date(Date.now() + 60_000)
    put(dirOf(emu, A), 'user', 'a2'); put(dirOf(emu, B), 'user', 'b2')
    utimesSync(join(dirOf(emu, A), 'user'), future, future); utimesSync(join(dirOf(emu, B), 'user'), future, future)
    expect(await learnCemuKey(db, 1, mlc, snap)).toBeNull()
  })
})

describe('PCSX2 : états et cartes mémoire dédiées', () => {
  const S1 = 'SLES-52541', S2 = 'SLUS-21050'
  it('chaque jeu ne voit que ses états et ses cartes, restaurés à leur place', async () => {
    const emu = install('pcsx2')
    put(emu, 'sstates', `${S1} (B440A8FE).01.p2s`, 'etat1')
    put(emu, 'sstates', `${S2} (11111111).01.p2s`, 'etat2')
    put(emu, 'memcards', `RomVault-${S1}`, 'BESLES-52541GTASAV', 'a.bin', 'carte1')
    put(emu, 'memcards', `RomVault-${S2}`, 'BASLUS-21050SAVE', 'b.bin', 'carte2')
    put(emu, 'memcards', 'Mcd001.ps2', 'partagee')
    expect(await saveInfo(db, saves(), entry(1, 'ps2', S1))).toMatchObject({ scope: 'game', files: 2 })
    expect(await saveInfo(db, saves(), entry(2, 'ps2', S2))).toMatchObject({ scope: 'game', files: 2 })
    const b = await backupSaves(db, saves(), entry(1, 'ps2', S1))
    rmSync(join(emu, 'memcards', `RomVault-${S1}`), { recursive: true }); rmSync(join(emu, 'sstates', `${S1} (B440A8FE).01.p2s`))
    await restoreSaves(db, saves(), entry(1, 'ps2', S1), b!.name)
    expect(read(emu, 'memcards', `RomVault-${S1}`, 'BESLES-52541GTASAV', 'a.bin')).toBe('carte1')
    expect(read(emu, 'sstates', `${S1} (B440A8FE).01.p2s`)).toBe('etat1')
    expect(read(emu, 'memcards', `RomVault-${S2}`, 'BASLUS-21050SAVE', 'b.bin')).toBe('carte2')
    expect(read(emu, 'memcards', 'Mcd001.ps2')).toBe('partagee')
  })
  it('supprimer la sauvegarde d\'un jeu ne touche ni l\'autre jeu ni la carte partagée', async () => {
    const emu = install('pcsx2')
    put(emu, 'memcards', `RomVault-${S1}`, 'BESLES-52541A', 'a', '1')
    put(emu, 'memcards', `RomVault-${S2}`, 'BASLUS-21050A', 'b', '2')
    put(emu, 'memcards', 'Mcd001.ps2', 'partagee')
    await deleteGameSaves(db, saves(), entry(1, 'ps2', S1))
    expect(existsSync(join(emu, 'memcards', `RomVault-${S1}`))).toBe(false)
    expect(existsSync(join(emu, 'memcards', `RomVault-${S2}`))).toBe(true)
    expect(existsSync(join(emu, 'memcards', 'Mcd001.ps2'))).toBe(true)
  })
  it('carte créée avant que le numéro de série soit connu (RomVault-g<id>) : reconnue comme celle du jeu', async () => {
    const emu = install('pcsx2')
    put(emu, 'memcards', 'RomVault-g7', 'BESLES-52541A', 'a', '1')
    expect(await saveInfo(db, saves(), entry(7, 'ps2', S1))).toMatchObject({ scope: 'game', files: 1 })
    expect(await saveInfo(db, saves(), entry(8, 'ps2', S2))).toMatchObject({ scope: 'game', files: 0 })
  })
})

describe('DuckStation, PPSSPP, RPCS3, Azahar, Eden, Vita3K, Dolphin : un jeu, ses fichiers', () => {
  it('DuckStation : états et carte du numéro de série', async () => {
    const emu = install('duckstation')
    put(emu, 'savestates', 'SCES-01438_1.sav', 'e1'); put(emu, 'savestates', 'SLUS-00001_1.sav', 'e2')
    put(emu, 'memcards', 'SCES-01438_1.mcd', 'c1'); put(emu, 'memcards', 'SLUS-00001_1.mcd', 'c2'); put(emu, 'memcards', 'shared_card_1.mcd', 'partagee')
    expect(await saveInfo(db, saves(), entry(1, 'ps1', 'SCES-01438'))).toMatchObject({ scope: 'game', files: 2 })
    await deleteGameSaves(db, saves(), entry(1, 'ps1', 'SCES-01438'))
    expect(existsSync(join(emu, 'memcards', 'SLUS-00001_1.mcd'))).toBe(true)
    expect(existsSync(join(emu, 'memcards', 'shared_card_1.mcd'))).toBe(true)
    expect(existsSync(join(emu, 'memcards', 'SCES-01438_1.mcd'))).toBe(false)
  })
  it("DuckStation : la carte nommée d'après le titre est reconnue à ses sauvegardes, pas la carte partagée ni celle d'un autre jeu", async () => {
    const emu = install('duckstation')
    const card = (names: string[]): Buffer => {
      const c = Buffer.alloc(131072); c.write('MC', 0, 'latin1')
      names.forEach((n, i) => { const f = 128 * (i + 1); c[f] = 0x51; c.write(n, f + 10, 'latin1') })
      return c
    }
    writeFileSync(join(emu, 'x'), '')
    put(emu, 'memcards', 'placeholder', 'x')
    writeFileSync(join(emu, 'memcards', 'Spyro the Dragon (Europe) (En,Fr,De,Es,It)_1.mcd'), card(['BESCES-01438SPYRO']))
    writeFileSync(join(emu, 'memcards', 'Autre jeu_1.mcd'), card(['BASLUS-00001AUTRE']))
    writeFileSync(join(emu, 'memcards', 'shared_card_1.mcd'), card(['BESCES-01438SPYRO', 'BASLUS-00001AUTRE']))
    const info = await saveInfo(db, saves(), entry(1, 'ps1', 'SCES-01438'))
    expect(info).toMatchObject({ scope: 'game', files: 1 })
    expect(info!.location).toContain('memcards')
    await deleteGameSaves(db, saves(), entry(1, 'ps1', 'SCES-01438'))
    expect(existsSync(join(emu, 'memcards', 'Autre jeu_1.mcd'))).toBe(true)
    expect(existsSync(join(emu, 'memcards', 'shared_card_1.mcd'))).toBe(true)
    expect(existsSync(join(emu, 'memcards', 'Spyro the Dragon (Europe) (En,Fr,De,Es,It)_1.mcd'))).toBe(false)
  })
  it('PPSSPP : dossiers SAVEDATA du jeu et états, pas ceux d\'un autre jeu', async () => {
    const emu = install('ppsspp')
    put(emu, 'memstick', 'PSP', 'SAVEDATA', 'UCES008420', 'DATA.BIN', 'a'); put(emu, 'memstick', 'PSP', 'SAVEDATA', 'UCES008421', 'DATA.BIN', 'a2')
    put(emu, 'memstick', 'PSP', 'SAVEDATA', 'ULUS100410', 'DATA.BIN', 'b')
    put(emu, 'memstick', 'PSP', 'PPSSPP_STATE', 'UCES00842_1.00_0.ppst', 's'); put(emu, 'memstick', 'PSP', 'PPSSPP_STATE', 'ULUS10041_1.00_0.ppst', 't')
    expect(await saveInfo(db, saves(), entry(1, 'psp', 'UCES00842'))).toMatchObject({ scope: 'game', files: 3 })
    expect(await saveInfo(db, saves(), entry(2, 'psp', 'ULUS10041'))).toMatchObject({ scope: 'game', files: 2 })
  })
  it('RPCS3 : dossiers du numéro de série, sous chaque utilisateur', async () => {
    const emu = install('rpcs3')
    put(emu, 'dev_hdd0', 'home', '00000001', 'savedata', 'BLES01179-AUTOSAVE', 'PARAM.SFO', 'a')
    put(emu, 'dev_hdd0', 'home', '00000002', 'savedata', 'BLES01179-SLOT', 'PARAM.SFO', 'a2')
    put(emu, 'dev_hdd0', 'home', '00000001', 'savedata', 'BLUS30443-AUTOSAVE', 'PARAM.SFO', 'b')
    expect(await saveInfo(db, saves(), entry(1, 'ps3', 'BLES01179'))).toMatchObject({ scope: 'game', files: 2 })
    expect(await saveInfo(db, saves(), entry(2, 'ps3', 'BLUS30443'))).toMatchObject({ scope: 'game', files: 1 })
  })
  it('Azahar : états et données du Title ID', async () => {
    const emu = install('azahar'), zeros = '0'.repeat(32)
    put(emu, 'user', 'states', '000400000008F800.01.cst', 's'); put(emu, 'user', 'states', '0004000000000000.01.cst', 'autre')
    put(emu, 'user', 'sdmc', 'Nintendo 3DS', zeros, zeros, 'title', '00040000', '0008f800', 'data', '00000001', 'save.bin', 'd')
    put(emu, 'user', 'sdmc', 'Nintendo 3DS', zeros, zeros, 'title', '00040000', '00000000', 'data', '00000001', 'o.bin', 'o')
    expect(await saveInfo(db, saves(), entry(1, 'n3ds', '000400000008F800'))).toMatchObject({ scope: 'game', files: 2 })
  })
  it('Eden : dossier du Title ID sous chaque utilisateur', async () => {
    const emu = install('eden'), tid = '0100ABCD00000000'
    put(emu, 'user', 'nand', 'user', 'save', '0000000000000000', 'U1', tid, 'a.dat', 'x'); put(emu, 'user', 'nand', 'user', 'save', '0000000000000000', 'U1', '0100000000000000', 'b.dat', 'y')
    expect(await saveInfo(db, saves(), entry(1, 'switch', tid))).toMatchObject({ scope: 'game', files: 1 })
  })
  it('Vita3K : dossier du Title ID', async () => {
    const emu = install('vita3k')
    put(emu, 'ux0', 'user', '00', 'savedata', 'PCSE00001', 'a.bin', 'x'); put(emu, 'ux0', 'user', '00', 'savedata', 'PCSE00002', 'b.bin', 'y')
    expect(await saveInfo(db, saves(), entry(1, 'vita', 'PCSE00001'))).toMatchObject({ scope: 'game', files: 1 })
  })
  it('Dolphin : fichiers de l\'identifiant de disque', async () => {
    const emu = install('dolphin')
    put(emu, 'User', 'GC', 'EUR', 'Card A', '01-GZLP-zelda.gci', 'x'); put(emu, 'User', 'GC', 'EUR', 'Card A', '01-RMCP-kart.gci', 'y')
    put(emu, 'User', 'StateSaves', 'GZLP01.s01', 's')
    expect(await saveInfo(db, saves(), entry(1, 'gc', 'GZLP01'))).toMatchObject({ scope: 'game', files: 2 })
  })
})

describe('identification : du jeu lui-même, pas d\'un nom ni d\'un chemin', () => {
  it('PSP en .cso : l\'identifiant est lu dans l\'image compressée, puis réutilisé après une réinstallation de la base', async () => {
    const emu = install('ppsspp')
    put(emu, 'memstick', 'PSP', 'SAVEDATA', 'ULUS100410', 'DATA.BIN', 'b'); put(emu, 'memstick', 'PSP', 'SAVEDATA', 'UCES008420', 'DATA.BIN', 'a')
    const file = join(dir, 'jeu.cso')
    writeFileSync(file, makeCso(miniIso('PARAM.SFO;1', makeSfo('DISC_ID', 'ULUS10041'), ['PSP_GAME']), 'cso'))
    db.prepare("INSERT INTO library (id, console, title, path, size, match, added_at) VALUES (3, 'psp', 'Jeu', ?, 1, 'hash', 1)").run(file)
    expect(await saveInfo(db, saves(), { id: 3, console: 'psp', path: file })).toMatchObject({ scope: 'game', files: 1 })
    expect((db.prepare('SELECT game_key FROM library WHERE id = 3').get() as { game_key: string }).game_key).toBe('ULUS10041')
    // Nouvelle base (réinstallation de RomVault) : même jeu, même fichier, mêmes sauvegardes — sans rien avoir mémorisé.
    const fresh = new DatabaseSync(':memory:'); migrate(fresh)
    saveEmulator(fresh, { id: 'ppsspp', version: '1', dir: emu, exe: join(emu, 'e.exe'), custom: false })
    expect(await saveInfo(fresh, saves(), { id: 99, console: 'psp', path: file })).toMatchObject({ scope: 'game', files: 1 })
  })
  it('PS1 en .bin brut : numéro de série lu dans SYSTEM.CNF', async () => {
    const emu = install('duckstation')
    put(emu, 'savestates', 'SCES-01438_1.sav', 'e1'); put(emu, 'savestates', 'SLUS-00001_1.sav', 'e2')
    const file = join(dir, 'spyro.bin')
    writeFileSync(file, toRawSectors(miniIso('SYSTEM.CNF;1', 'BOOT = cdrom:\\SCES_014.38;1\r\n')))
    expect(await saveInfo(db, saves(), { id: 4, console: 'ps1', path: file })).toMatchObject({ scope: 'game', files: 1 })
  })
  it('dernier recours seulement : identifiant introuvable → sauvegardes de l\'émulateur entier', async () => {
    const emu = install('duckstation')
    put(emu, 'savestates', 'SCES-01438_1.sav', 'e1')
    expect(await saveInfo(db, saves(), { id: 5, console: 'ps1', path: join(dir, 'illisible.chd') })).toMatchObject({ scope: 'emulator' })
  })
})
