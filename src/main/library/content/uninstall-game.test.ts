import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { migrate } from '../../db/migrations'
import { saveEmulator } from '../../emulators/emulatorStore'
import { importPaths } from '../importer'
import { clearLibrary, deleteAllRomFiles, listLibrary, removeEntry } from '../libraryStore'
import { makeCia, nspWithXml } from './content.testutil'

// Désinstaller un jeu désinstalle TOUS ses contenus additionnels : côté émulateur (ce que l'installateur y avait mis), puis le rangement de RomVault, puis les lignes.
// Tests synthétiques : ils valident la logique de RomVault, pas qu'un émulateur ait réellement perdu le contenu.

const GAME = '0100000000010000', UPD = '0100000000010800', DLC = '0100000000011001'
const GAME_3DS = '0004000000030800', UPD_3DS = '0004000E00030800', DLC_3DS = '0004008C00030800'

let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-uninst-game-')); db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const roms = (): string => join(dir, 'roms')
const saves = (): string => join(dir, 'saves')
const opt = (copy = true): Parameters<typeof importPaths>[2] => ({ copy, deleteSource: false, romsDir: roms(), logDir: join(dir, 'logs') })
const put = (name: string, data: Buffer | string): string => { const p = join(dir, 'src', name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); return p }
const rows = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const contentPaths = (): string[] => (db.prepare('SELECT path FROM library_content').all() as { path: string }[]).map((r) => r.path)

const importSwitch = async (copy = true): Promise<{ upd: string; dlc: string }> => {
  const upd = put('Update.nsp', nspWithXml('update', UPD, 65536, GAME))
  const dlc = put('DLC.nsp', nspWithXml('dlc', DLC, 0, GAME))
  await importPaths(db, [put('Game.nsp', nspWithXml('base', GAME)), upd, dlc], opt(copy))
  return { upd, dlc }
}

describe('Switch — désinstaller le jeu', () => {
  it('« Désinstaller » (action file) : ROM, mises à jour et DLC rangés par RomVault disparaissent ; la fiche reste, sans fichier', async () => {
    await importSwitch()
    const kept = contentPaths()
    expect(kept).toHaveLength(2)
    await removeEntry(db, 1, 'file', saves(), roms())
    expect(kept.every((p) => !existsSync(p))).toBe(true)
    expect(existsSync(join(roms(), 'switch', '.content', GAME))).toBe(false) // dossier du jeu retiré aussi
    expect(rows('library_content')).toBe(0)
    expect(listLibrary(db)).toHaveLength(1)
    expect(listLibrary(db)[0].missing).toBe(true)
  })
  it('suppression complète (action all) : idem, et la fiche disparaît', async () => {
    await importSwitch()
    await removeEntry(db, 1, 'all', saves(), roms())
    expect(listLibrary(db)).toHaveLength(0)
    expect(rows('library_content')).toBe(0)
    expect(existsSync(join(roms(), 'switch', '.content', GAME))).toBe(false)
  })
  it('mode « ne pas copier » : les fichiers que l’utilisateur a laissés chez lui ne sont JAMAIS supprimés (seuls les liens rangés par RomVault le sont)', async () => {
    const { upd, dlc } = await importSwitch(false)
    await removeEntry(db, 1, 'file', saves(), roms())
    expect(existsSync(upd)).toBe(true)
    expect(existsSync(dlc)).toBe(true)
    expect(rows('library_content')).toBe(0)
  })
  it('le contenu d’un AUTRE jeu n’est pas touché', async () => {
    await importSwitch()
    await importPaths(db, [put('Game2.nsp', nspWithXml('base', '0100000000020000')), put('Upd2.nsp', nspWithXml('update', '0100000000020800', 1, '0100000000020000'))], opt())
    const other = (db.prepare("SELECT path FROM library_content WHERE title_id = '0100000000020800'").get() as { path: string }).path
    await removeEntry(db, 1, 'file', saves(), roms())
    expect(existsSync(other)).toBe(true)
    expect(rows('library_content')).toBe(1)
  })
  it('retirer le jeu de la bibliothèque en GARDANT sa ROM (action entry) : ses contenus attendent le jeu et se rattachent s’il est réimporté', async () => {
    await importSwitch()
    const files = contentPaths()
    await removeEntry(db, 1, 'entry', saves(), roms())
    expect(listLibrary(db)).toHaveLength(0)
    expect(rows('library_orphans')).toBe(2)
    expect(files.every((p) => existsSync(p))).toBe(true)
    await importPaths(db, [put('Game.nsp', nspWithXml('base', GAME))], opt())
    expect(rows('library_content')).toBe(2)
    expect(rows('library_orphans')).toBe(0)
  })
  it('supprimer les fichiers de TOUS les jeux (action dangereuse) désinstalle aussi tous les contenus', async () => {
    await importSwitch()
    const files = contentPaths()
    await deleteAllRomFiles(db, roms())
    expect(files.every((p) => !existsSync(p))).toBe(true)
    expect(rows('library_content')).toBe(0)
  })
  it('vider la bibliothèque (action dangereuse) : les fichiers de contenu restent, en attente de leurs jeux', async () => {
    await importSwitch()
    const files = contentPaths()
    clearLibrary(db)
    expect(rows('library')).toBe(0)
    expect(rows('library_orphans')).toBe(2)
    expect(files.every((p) => existsSync(p))).toBe(true)
  })
  it('sans dossier de ROM connu, rien n’est supprimé (on ne sait pas distinguer le rangement de RomVault)', async () => {
    await importSwitch()
    const files = contentPaths()
    await removeEntry(db, 1, 'file', saves())
    expect(files.every((p) => existsSync(p))).toBe(true)
  })
})

describe('3DS — l’émulateur perd lui aussi les contenus installés', () => {
  const azahar = (): string => {
    const d = join(dir, 'azahar')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'azahar.exe'), 'x')
    saveEmulator(db, { id: 'azahar', version: 't', dir: d, exe: join(d, 'azahar.exe'), custom: false })
    return d
  }
  it('mise à jour et DLC installés dans Azahar : leurs dossiers de titre sont retirés avec le jeu', async () => {
    const emu = azahar()
    await importPaths(db, [put('game.cia', makeCia(GAME_3DS)), put('upd.cia', makeCia(UPD_3DS)), put('dlc.cia', makeCia(DLC_3DS))], opt())
    const title = (hi: string, lo: string): string => join(emu, 'user', 'sdmc', 'Nintendo 3DS', '0'.repeat(32), '0'.repeat(32), 'title', hi, lo)
    for (const [hi, lo] of [['0004000e', '00030800'], ['0004008c', '00030800']]) { mkdirSync(join(title(hi, lo), 'content'), { recursive: true }); writeFileSync(join(title(hi, lo), 'content', '00000000.app'), 'x') }
    db.prepare("UPDATE library_content SET state = 'installed', installed_at = ?").run(Date.now())
    await removeEntry(db, 1, 'file', saves(), roms())
    expect(existsSync(title('0004000e', '00030800'))).toBe(false)
    expect(existsSync(title('0004008c', '00030800'))).toBe(false)
    expect(rows('library_content')).toBe(0)
  })
  it('contenu jamais installé dans l’émulateur : rien à y défaire, les fichiers rangés partent quand même', async () => {
    azahar()
    await importPaths(db, [put('game.cia', makeCia(GAME_3DS)), put('upd.cia', makeCia(UPD_3DS))], opt())
    const files = contentPaths()
    await removeEntry(db, 1, 'file', saves(), roms())
    expect(files.every((p) => !existsSync(p))).toBe(true)
    expect(rows('library_content')).toBe(0)
  })
})
