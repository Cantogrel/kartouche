import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'
import { migrate } from '../db/migrations'
import { extractZipEntries, hashFile, readZip, readZipEntryText } from './hash'
import { identify } from './identify'
import { importPaths } from './importer'
import { addCatalogGame, clearLibrary, deleteAllRomFiles, importSbi, listLibrary, relinkUnmatched, removeEntry, saveDir, sbiPathFor } from './libraryStore'
import { extensionsForConsoles, ROM_EXTENSIONS } from '@shared/library'

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
let dir: string
let db: DatabaseSync
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-')); db = new DatabaseSync(':memory:'); migrate(db) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const addGame = (console: string, title: string, base: string, crc: string | null, size: number | null, dup = 0): number =>
  Number(db.prepare('INSERT INTO catalog_games (console, title, name, crc, size, base, dup) VALUES (?, ?, ?, ?, ?, ?, ?)').run(console, title, title, crc, size, base, dup).lastInsertRowid)

/** Zip minimal (une entrée compressée) pour tester la lecture du répertoire central. */
function makeZip(name: string, data: Buffer): Buffer {
  return makeZipMulti([{ name, data }])
}

/** Zip à plusieurs entrées (méthode déflate), pour tester une archive disque .cue + pistes. */
function makeZipMulti(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  for (const { name, data } of files) {
    const comp = deflateRawSync(data), nm = Buffer.from(name), crc = crc32(data)
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26)
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28)
    cd.writeUInt32LE(off, 42)
    locals.push(lh, nm, comp)
    centrals.push(cd, nm)
    off += lh.length + nm.length + comp.length
  }
  const cdStart = off
  const cdBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...locals, cdBuf, end])
}

describe('extensions de ROM', () => {
  it('n’accepte que des extensions vérifiées comme réellement ouvrables par l’émulateur de la console (voir le commentaire de ROM_EXTENSIONS)', () => {
    // .gc n'existe pas (Dolphin ne le connaît pas) ; .nsz/.xcz ont besoin d'être décompressés avant qu'Eden ne les
    // ouvre ; .pkg PS3 a besoin d'un install préalable (RPCS3 --installpkg) jamais implémenté ici.
    expect(ROM_EXTENSIONS.gc).toBeUndefined()
    expect(ROM_EXTENSIONS.nsz).toBeUndefined()
    expect(ROM_EXTENSIONS.xcz).toBeUndefined()
    expect(ROM_EXTENSIONS.pkg).toBeUndefined()
    // .img : légitime seulement pour PS1 (DuckStation) — absent des formats supportés par PCSX2 (PS2).
    expect(ROM_EXTENSIONS.img).toEqual(['ps1'])
    expect(extensionsForConsoles(['ps2'])).not.toContain('img')
    expect(extensionsForConsoles(['ps1'])).toContain('img')
  })
})

describe('hash', () => {
  it('calcule CRC32 et SHA1 (« 123456789 » → cbf43926)', async () => {
    const f = join(dir, 'a.bin'); writeFileSync(f, '123456789')
    const h = await hashFile(f)
    expect(h.crc).toBe('cbf43926'); expect(h.size).toBe(9); expect(h.sha1).toBe('f7c3bc1d808e04732adf679965ccc34ca7ae3441')
  })
  it('lit le CRC et la taille dans un zip sans décompresser', async () => {
    const data = Buffer.from('hello rom'); const f = join(dir, 'a.zip'); writeFileSync(f, makeZip('Game.nes', data))
    expect(await readZip(f)).toEqual([{ name: 'Game.nes', crc: hex(crc32(data)), size: data.length }])
  })
  it('renvoie null pour un fichier qui n’est pas un zip', async () => {
    const f = join(dir, 'x.zip'); writeFileSync(f, 'pas un zip'); expect(await readZip(f)).toBeNull()
  })
  it('lit le texte d’une entrée et en extrait plusieurs vers des chemins choisis', async () => {
    const cue = Buffer.from('FILE "Disc (Track 1).bin" BINARY\n')
    const track = Buffer.from('piste')
    const f = join(dir, 'disc.zip')
    writeFileSync(f, makeZipMulti([{ name: 'Disc.cue', data: cue }, { name: 'Disc (Track 1).bin', data: track }]))
    expect(await readZipEntryText(f, 'Disc.cue')).toBe(cue.toString('latin1'))
    expect(await readZipEntryText(f, 'absent.cue')).toBeNull()
    const out1 = join(dir, 'out1.cue'), out2 = join(dir, 'out2.bin')
    expect(await extractZipEntries(f, [{ entry: 'Disc.cue', dest: out1 }, { entry: 'Disc (Track 1).bin', dest: out2 }])).toBe(true)
    expect(readFileSync(out1)).toEqual(cue); expect(readFileSync(out2)).toEqual(track)
    expect(await extractZipEntries(f, [{ entry: 'inconnu.bin', dest: join(dir, 'out3') }])).toBe(false)
  })
})

describe('identify', () => {
  it('reconnaît par CRC + taille et ramène une version dupliquée à l’entrée représentative', () => {
    const rep = addGame('nes', 'Zelda (Europe)', 'zelda', 'aaaaaaaa', 10)
    addGame('nes', 'Zelda (USA)', 'zelda', 'bbbbbbbb', 10, 1)
    const r = identify(db, { name: 'x', ext: 'nes', crc: 'BBBBBBBB', size: 10 })
    expect(r).toMatchObject({ gameId: rep, console: 'nes', match: 'hash' })
    expect(identify(db, { name: 'x', ext: 'nes', crc: 'bbbbbbbb', size: 11 }).gameId).toBeNull()
    const up = addGame('gba', 'Maj', 'maj', '9D4F1E18', 3)
    expect(identify(db, { name: 'x', ext: 'gba', crc: '9d4f1e18', size: 3 }).gameId).toBe(up) // DAT en majuscules
  })
  it('l’extension tranche une collision de CRC entre consoles', () => {
    addGame('gb', 'Jeu', 'jeu', 'cccccccc', 5); const gbc = addGame('gbc', 'Jeu', 'jeu', 'cccccccc', 5)
    expect(identify(db, { name: 'x', ext: 'gbc', crc: 'cccccccc', size: 5 }).gameId).toBe(gbc)
  })
  it('retombe sur le nom quand aucune empreinte ne correspond (Switch)', () => {
    const id = addGame('switch', 'Mario Kart 8 Deluxe', 'mariokart8deluxe', null, null)
    expect(identify(db, { name: 'Mario Kart 8 Deluxe [0100152000022000][v0]', ext: 'nsp' }).gameId).toBe(id) // les crochets du dump sont ignorés
    expect(identify(db, { name: 'Mario Kart 8 Deluxe (Europe)', ext: 'nsp' })).toMatchObject({ gameId: id, match: 'name' })
  })
  it('signale l’ambiguïté d’un .iso inconnu et devine la console d’une extension unique', () => {
    expect(identify(db, { name: 'inconnu', ext: 'iso' })).toMatchObject({ gameId: null, console: null })
    expect(identify(db, { name: 'inconnu', ext: 'gba' })).toMatchObject({ gameId: null, console: 'gba', match: 'none' })
  })
})

describe('import', () => {
  const opt = () => ({ copy: true, deleteSource: false, romsDir: join(dir, 'roms') })
  const rom = (name: string, content: string): string => { const f = join(dir, 'src', name); mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(f, content); return f }

  it('identifie, copie dans roms/<console> et enregistre ; un second import est un doublon', async () => {
    const f = rom('Test.nes', '123456789')
    const id = addGame('nes', 'Test (Europe)', 'test', 'cbf43926', 9)
    const r = await importPaths(db, [f], opt())
    expect(r.items[0]).toMatchObject({ status: 'added', console: 'nes', match: 'hash' })
    expect(existsSync(join(dir, 'roms', 'nes', 'Test.nes'))).toBe(true); expect(existsSync(f)).toBe(true)
    expect(listLibrary(db)[0]).toMatchObject({ gameId: id, console: 'nes', missing: false })
    expect((await importPaths(db, [f], opt())).items[0].status).toBe('duplicate')
  })
  it('supprime l’original après copie vérifiée si demandé', async () => {
    const f = rom('Test.nes', '123456789'); addGame('nes', 'Test', 'test', 'cbf43926', 9)
    await importPaths(db, [f], { ...opt(), deleteSource: true })
    expect(existsSync(f)).toBe(false); expect(readdirSync(join(dir, 'roms', 'nes'))).toEqual(['Test.nes'])
  })
  it('sans copie, référence le fichier en place ; parcourt un dossier et ignore le reste', async () => {
    rom('a.gba', 'aaa'); rom('b.gba', 'bbb'); rom('notes.txt', 'x')
    const r = await importPaths(db, [join(dir, 'src')], { ...opt(), copy: false })
    expect(r.items.filter((i) => i.status === 'added')).toHaveLength(2); expect(r.ignored).toBe(1)
    expect(existsSync(join(dir, 'roms'))).toBe(false)
  })
  it('lit un zip d’une ROM et signale un .iso ambigu sans l’importer', async () => {
    const data = Buffer.from('zip rom'); const z = join(dir, 'Zip.sfc.zip'); writeFileSync(z, makeZip('Zip.sfc', data))
    addGame('snes', 'Zip', 'zip', hex(crc32(data)), data.length)
    expect((await importPaths(db, [z], opt())).items[0]).toMatchObject({ status: 'added', console: 'snes', match: 'hash' })
    expect((await importPaths(db, [rom('mystere.iso', 'zzz')], opt())).items[0].status).toBe('ambiguous')
  })
  it('emporte les pistes d’une feuille .cue et ne les importe pas seules', async () => {
    rom('Disc (Track 1).bin', 'track'); const cue = rom('Disc.cue', 'FILE "Disc (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n')
    const r = await importPaths(db, [join(dir, 'src')], { ...opt(), copy: true })
    expect(r.items).toHaveLength(1)
    expect(r.items[0].file).toBe(cue) // console ambiguë ps1/ps2 → non importée, mais une seule entrée (la piste est absorbée)
    expect(r.items[0].status).toBe('ambiguous')
  })
  it('extrait un zip .cue + piste (archive à plusieurs fichiers, sinon rejetée avant)', async () => {
    const track = Buffer.from('piste')
    const z = join(dir, 'src', 'Disc.zip')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(z, makeZipMulti([
      { name: 'Disc.cue', data: Buffer.from('FILE "Disc (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n') },
      { name: 'Disc (Track 1).bin', data: track }
    ]))
    const id = addGame('ps1', 'Disc', 'disc', hex(crc32(track)), track.length)
    const r = await importPaths(db, [z], opt())
    expect(r.items[0]).toMatchObject({ status: 'added', console: 'ps1', match: 'hash' })
    expect(existsSync(join(dir, 'roms', 'ps1', 'Disc.cue'))).toBe(true)
    expect(readFileSync(join(dir, 'roms', 'ps1', 'Disc (Track 1).bin'))).toEqual(track)
    expect(listLibrary(db)[0]).toMatchObject({ gameId: id, console: 'ps1', missing: false })
    // Un zip à plusieurs fichiers sans .cue reconnaissable reste rejeté.
    const bad = join(dir, 'src', 'Bad.zip')
    writeFileSync(bad, makeZipMulti([{ name: 'a.bin', data: Buffer.from('a') }, { name: 'b.bin', data: Buffer.from('b') }]))
    expect((await importPaths(db, [bad], opt())).items[0].status).toBe('error')
  })
})

describe('bibliothèque', () => {
  const opt = () => ({ copy: true, deleteSource: false, romsDir: join(dir, 'roms') })
  const rom = (name: string, content: string): string => { const f = join(dir, 'src', name); mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(f, content); return f }

  it('un jeu ajouté depuis le catalogue est sans fichier ; la ROM importée s’y rattache', async () => {
    const id = addGame('nes', 'Test (Europe)', 'test', 'cbf43926', 9)
    const e = addCatalogGame(db, id)!
    expect(e).toMatchObject({ gameId: id, missing: true })
    expect(addCatalogGame(db, id)!.id).toBe(e.id) // pas de doublon
    const r = await importPaths(db, [rom('Test.nes', '123456789')], opt())
    expect(r.items[0].status).toBe('added')
    const list = listLibrary(db)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: e.id, missing: false, match: 'hash' })
  })
  it("hasSources reflète si une liste de sources propose un téléchargement pour ce jeu", async () => {
    const withSource = addGame('nes', 'Avec source (Europe)', 'avecsource', 'cbf43926', 9)
    const withoutSource = addGame('nes', 'Sans source (Europe)', 'sanssource', 'AAAAAAAA', 9)
    addCatalogGame(db, withSource)
    addCatalogGame(db, withoutSource)
    db.prepare("INSERT INTO source_lists (id, name, url, added_at) VALUES (1, 'L', 'https://x/l.json', 0)").run()
    db.prepare("INSERT INTO sources (list_id, game_id, console, title, uris) VALUES (1, ?, 'nes', 'Avec source', '[]')").run(withSource)
    const list = listLibrary(db)
    expect(list.find((e) => e.gameId === withSource)).toMatchObject({ hasSources: true })
    expect(list.find((e) => e.gameId === withoutSource)).toMatchObject({ hasSources: false })
  })

  it('un paquet PS Vita en .zip (eboot.bin + sce_sys/, un .vpk n’est qu’un zip renommé) est importé tel quel, jamais extrait', async () => {
    const f = join(dir, 'src', 'Game.zip')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(f, makeZipMulti([{ name: 'eboot.bin', data: Buffer.from('boot') }, { name: 'sce_sys/keystone', data: Buffer.from('key') }]))
    const r = await importPaths(db, [f], opt())
    expect(r.items[0].status).toBe('added')
    const [e] = listLibrary(db)
    expect(e.console).toBe('vita')
    expect(e.path.endsWith('.zip')).toBe(true)
  })
  it('supprimer le fichier garde le jeu (sans fichier) ; le réimporter le rattache de nouveau', async () => {
    addGame('nes', 'Test', 'test', 'cbf43926', 9)
    const f = rom('Test.nes', '123456789')
    await importPaths(db, [f], opt())
    const [e] = listLibrary(db)
    await removeEntry(db, e.id, 'file', join(dir, 'saves'))
    expect(existsSync(e.path)).toBe(false)
    expect(listLibrary(db)).toHaveLength(1); expect(listLibrary(db)[0].missing).toBe(true)
    expect((await importPaths(db, [f], opt())).items[0].status).toBe('added')
    expect(listLibrary(db)).toHaveLength(1); expect(listLibrary(db)[0].missing).toBe(false)
  })
  it('supprimer le fichier d’un jeu Vita3K réinitialise son Title ID (la copie que Vita3K a installée à part ne vaudrait plus rien)', async () => {
    addGame('vita', 'Test Vita', 'test', 'cbf43926', 9)
    await importPaths(db, [rom('Test.vpk', '123456789')], opt())
    const [e] = listLibrary(db)
    db.prepare('UPDATE library SET vita_title_id = ? WHERE id = ?').run('TESTVITA01', e.id)
    await removeEntry(db, e.id, 'file', join(dir, 'saves'))
    expect((db.prepare('SELECT vita_title_id FROM library WHERE id = ?').get(e.id) as { vita_title_id: string | null }).vita_title_id).toBeNull()
  })
  it('retirer de la bibliothèque garde la ROM ; « tout supprimer » enlève ROM, sauvegardes et entrée', async () => {
    addGame('nes', 'Test', 'test', 'cbf43926', 9)
    await importPaths(db, [rom('Test.nes', '123456789')], opt())
    const saves = join(dir, 'saves')
    const [e] = listLibrary(db)
    mkdirSync(saveDir(saves, e), { recursive: true }); writeFileSync(join(saveDir(saves, e), 'a.sav'), 'x')
    await removeEntry(db, e.id, 'save', saves)
    expect(existsSync(saveDir(saves, e))).toBe(false); expect(existsSync(e.path)).toBe(true)
    await removeEntry(db, e.id, 'entry', saves)
    expect(listLibrary(db)).toHaveLength(0); expect(existsSync(e.path)).toBe(true)
    await importPaths(db, [rom('Test.nes', '123456789')], { ...opt(), copy: false })
    const [e2] = listLibrary(db)
    mkdirSync(saveDir(saves, e2), { recursive: true })
    await removeEntry(db, e2.id, 'all', saves)
    expect(listLibrary(db)).toHaveLength(0); expect(existsSync(e2.path)).toBe(false); expect(existsSync(saveDir(saves, e2))).toBe(false)
  })
  it('« vider la bibliothèque » retire toutes les entrées mais garde les fichiers ROM (Zone dangereuse)', async () => {
    addGame('nes', 'Test 1', 'test1', 'cbf43926', 9)
    addGame('snes', 'Test 2', 'test2', 'cbf43926', 9)
    await importPaths(db, [rom('Test 1.nes', '123456789'), rom('Test 2.sfc', '123456789')], opt())
    const [e1, e2] = listLibrary(db)
    clearLibrary(db)
    expect(listLibrary(db)).toHaveLength(0)
    expect(existsSync(e1.path)).toBe(true); expect(existsSync(e2.path)).toBe(true)
  })
  it('« supprimer tous les fichiers ROM » efface les fichiers mais garde les entrées, marquées sans fichier (Zone dangereuse)', async () => {
    addGame('nes', 'Test 1', 'test1', 'cbf43926', 9)
    addGame('snes', 'Test 2', 'test2', 'cbf43926', 9)
    await importPaths(db, [rom('Test 1.nes', '123456789'), rom('Test 2.sfc', '123456789')], opt())
    const noFile = addCatalogGame(db, addGame('gb', 'Test 3', 'test3', null, null))! // jeu ajouté sans ROM : pas touché
    const [e1, e2] = listLibrary(db)
    await deleteAllRomFiles(db)
    expect(existsSync(e1.path)).toBe(false); expect(existsSync(e2.path)).toBe(false)
    const list = listLibrary(db)
    expect(list).toHaveLength(3)
    expect(list.every((e) => e.missing)).toBe(true)
    expect(list.find((e) => e.id === noFile.id)).toMatchObject({ missing: true })
  })
  it('relie après coup un jeu importé sans fiche, une fois que le catalogue le connaît (rattrape un catalogue Switch incomplet lors de l’import)', async () => {
    // Le jeu manque encore au catalogue (ex. filtre IGDB alors trop strict) : importé quand même, sans fiche.
    const r = await importPaths(db, [rom('Mario Kart 8 Deluxe.nsp', '123456789')], opt())
    expect(r.items[0]).toMatchObject({ status: 'added', console: 'switch', match: 'none' }) // extension .nsp : console connue, jeu non
    expect(listLibrary(db)[0]).toMatchObject({ gameId: null })
    expect(relinkUnmatched(db)).toBe(0) // toujours rien à relier : le catalogue ne le connaît pas encore

    // Le catalogue est resynchronisé et le jeu y apparaît désormais.
    const id = addGame('switch', 'Mario Kart 8 Deluxe', 'mariokart8deluxe', null, null)
    expect(relinkUnmatched(db)).toBe(1)
    expect(listLibrary(db)[0]).toMatchObject({ gameId: id, match: 'name' })
    expect(relinkUnmatched(db)).toBe(0) // déjà relié : idempotent
  })
  it('relie aussi une entrée dont le game_id est orphelin (pointe vers une ligne de catalogue qui n’existe plus)', async () => {
    await importPaths(db, [rom('Mario Kart 8 Deluxe.nsp', '123456789')], opt())
    // game_id orphelin : simule une resynchro qui aurait régénéré les id (bug corrigé côté replaceConsole, testé ici en défense).
    db.prepare('UPDATE library SET game_id = 999999 WHERE id = 1').run()
    expect(listLibrary(db)[0].gameId).toBe(999999)
    const newId = addGame('switch', 'Mario Kart 8 Deluxe', 'mariokart8deluxe', null, null)
    expect(relinkUnmatched(db)).toBe(1)
    expect(listLibrary(db)[0]).toMatchObject({ gameId: newId, match: 'name' })
  })
  // Un jeu Switch lourd (Smash Bros Ultimate) importé avec sa mise à jour et ses DLC ne doit jamais devenir
  // plusieurs « jeux » identiques dans la bibliothèque (voir switchContent.ts). Eden n'a pas de commande pour
  // installer une mise à jour/un DLC (seulement son propre menu File > Install Files to NAND) : RomVault refuse
  // l'import plutôt que de copier un fichier qu'il ne peut de toute façon pas rendre jouable.
  it('refuse d’importer une mise à jour ou un DLC Switch (Title ID) sans toucher au fichier', async () => {
    const base = await importPaths(db, [rom('Smash Bros Ultimate [0100000000010000][v0].nsp', 'base')], opt())
    expect(base.items[0]).toMatchObject({ status: 'added', console: 'switch' })
    expect(listLibrary(db)).toHaveLength(1)

    const updFile = rom('Smash Bros Ultimate [0100000000010800][v131072].nsp', 'update')
    const upd = await importPaths(db, [updFile], opt())
    expect(upd.items[0]).toMatchObject({ status: 'error' })
    expect(upd.items[0].error).toMatch(/mise à jour switch/i)

    const dlcFile = rom('Piranha Plant [0100000000011001].nsp', 'dlc')
    const dlc = await importPaths(db, [dlcFile], opt())
    expect(dlc.items[0]).toMatchObject({ status: 'error' })
    expect(dlc.items[0].error).toMatch(/dlc switch/i)

    // Toujours un seul jeu dans la bibliothèque, et les fichiers d'origine n'ont pas bougé (jamais copiés ni supprimés).
    expect(listLibrary(db)).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_content').get()).toEqual({ n: 0 })
    expect(existsSync(updFile)).toBe(true)
    expect(existsSync(dlcFile)).toBe(true)
  })
  it('refuse aussi un DLC/mise à jour dont le jeu de base n’est pas dans la bibliothèque (même message, pas de jeu fantôme)', async () => {
    const r = await importPaths(db, [rom('Piranha Plant [0100000000011001].nsp', 'dlc')], opt())
    expect(r.items[0].status).toBe('error')
    expect(listLibrary(db)).toHaveLength(0)
  })
  // Cas réel rencontré : le dump de mise à jour n'a pas de Title ID dans son nom, seulement le mot « Update ».
  it('refuse aussi une mise à jour Switch sans Title ID lisible (repli mot-clé)', async () => {
    const f = rom('Super Smash Bros. Ultimate Switch NSP Update v2031616.nsp', 'update')
    const r = await importPaths(db, [f], opt())
    expect(r.items[0]).toMatchObject({ status: 'error' })
    expect(existsSync(f)).toBe(true)
  })
})

describe('sbi', () => {
  const opt = () => ({ copy: true, deleteSource: false, romsDir: join(dir, 'roms') })
  const rom = (name: string, content: string): string => { const f = join(dir, 'src', name); mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(f, content); return f }

  it('place le .sbi à côté de la ROM, sous le nom attendu ; refuse une console qui n’en a pas besoin ou un fichier qui n’est pas un .sbi', async () => {
    addGame('ps1', 'Disc', 'disc', 'cbf43926', 9)
    await importPaths(db, [rom('Disc.bin', '123456789')], opt())
    const [e] = listLibrary(db)
    expect(sbiPathFor(e)).toBe(join(dir, 'roms', 'ps1', 'Disc.sbi'))
    const sbi = join(dir, 'src', 'external.sbi'); writeFileSync(sbi, 'x')
    expect(await importSbi(db, e.id, sbi)).toMatchObject({ ok: true })
    expect(existsSync(join(dir, 'roms', 'ps1', 'Disc.sbi'))).toBe(true)
    const notSbi = join(dir, 'src', 'x.txt'); writeFileSync(notSbi, 'x')
    expect(await importSbi(db, e.id, notSbi)).toMatchObject({ ok: false, error: 'badFile' })
    expect(await importSbi(db, 999999, sbi)).toMatchObject({ ok: false, error: 'notFound' })

    const nesContent = 'nes cart!'
    addGame('nes', 'Cart', 'cart', hex(crc32(Buffer.from(nesContent))), nesContent.length)
    await importPaths(db, [rom('Cart.nes', nesContent)], opt())
    const nesEntry = listLibrary(db).find((x) => x.console === 'nes')!
    expect(sbiPathFor(nesEntry)).toBeNull()
    expect(await importSbi(db, nesEntry.id, sbi)).toMatchObject({ ok: false, error: 'notPs1' })
  })
})
