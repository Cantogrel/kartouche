import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { crc32 } from 'node:zlib'
import { migrate } from '../db/migrations'
import { archiveVolume, isSafeEntryPath, run7z, toVirtual, unpackArchive } from './archive'
import { readZip } from './hash'
import { importPaths } from './importer'
import { listLibrary } from './libraryStore'
import { installDownload } from '../downloads/install'
import { makeRar5, makeRar5Volumes } from './rar5.testutil'

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-arc-')); mkdirSync(join(dir, 'src'), { recursive: true }) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Crée une vraie archive avec 7-Zip (wasm) à partir de fichiers { nom: contenu }. */
async function make7z(archive: string, files: Record<string, Buffer | string>, extraArgs: string[] = []): Promise<string> {
  const src = join(dir, `mk-${Math.random().toString(36).slice(2)}`)
  mkdirSync(src, { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(join(src, name, '..'), { recursive: true })
    writeFileSync(join(src, name), data)
  }
  const r = await run7z(['a', '-spd', ...extraArgs, toVirtual(archive)!, '.'], [archive, src], src)
  if (r.code !== 0) throw new Error(`7z a : ${r.out}`)
  return archive
}

describe('noms de volumes', () => {
  it('reconnaît .7z, .rar, volumes .partN.rar et .7z.001', () => {
    expect(archiveVolume('a.7z')).toMatchObject({ kind: '7z', isFirst: true })
    expect(archiveVolume('a.RAR')).toMatchObject({ kind: 'rar', isFirst: true })
    expect(archiveVolume('a.part1.rar')).toMatchObject({ isFirst: true, first: 'a.part1.rar' })
    expect(archiveVolume('a.part02.rar')).toMatchObject({ isFirst: false, first: 'a.part01.rar' })
    expect(archiveVolume('a.7z.002')).toMatchObject({ kind: '7z', isFirst: false, first: 'a.7z.001' })
    expect(archiveVolume('a.zip')).toBeNull()
    expect(archiveVolume('a.nes')).toBeNull()
  })
  it('refuse les chemins d’entrée dangereux', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/x', '\\x', 'C:\\x', 'C:x', 'a:b', 'CON', 'dir/nul.txt', 'a/', 'x.', 'a\0b', 'a|b']) expect(isSafeEntryPath(bad), bad).toBe(false)
    for (const ok of ['Game.iso', 'dir/Game (Europe) [!].iso', 'Pokémon – 日本語.nds', 'a b/c.d']) expect(isSafeEntryPath(ok), ok).toBe(true)
  })
})

describe('unpackArchive', () => {
  const work = (): string => join(dir, 'work')

  it('.7z valide avec une ROM : renvoie la ROM extraite', async () => {
    const iso = Buffer.from('contenu iso '.repeat(500))
    const a = await make7z(join(dir, 'src', 'game.7z'), { 'Game.iso': iso })
    const r = await unpackArchive(a, work())
    expect(typeof r).toBe('object')
    if (typeof r === 'string') return
    expect(basename(r.file)).toBe('Game.iso')
    expect(readFileSync(r.file)).toEqual(iso)
    expect(r.volumes).toEqual([a])
  })
  it('.7z contenant une ROM et des fichiers annexes : prend la ROM, pas le premier fichier', async () => {
    const rom = Buffer.from('rom')
    const a = await make7z(join(dir, 'src', 'g.7z'), { 'a-readme.txt': 'lisez-moi', 'dossier/Jeu (Europe).nes': rom, 'z.nfo': 'x' })
    const r = await unpackArchive(a, work())
    expect(typeof r).toBe('object')
    if (typeof r !== 'string') expect(readFileSync(r.file)).toEqual(rom)
  })
  it('.7z avec plusieurs ROM différentes : refus explicite', async () => {
    const a = await make7z(join(dir, 'src', 'g.7z'), { 'a.nes': 'aaa', 'b.nes': 'bbb' })
    expect(await unpackArchive(a, work())).toMatch(/un seul fichier de ROM/)
  })
  it('.7z sans aucune ROM : refus explicite', async () => {
    const a = await make7z(join(dir, 'src', 'g.7z'), { 'notes.txt': 'rien' })
    expect(await unpackArchive(a, work())).toMatch(/aucune ROM/)
  })
  it('.7z disque .cue + pistes : reconditionné en .zip lisible par le chemin ZIP existant', async () => {
    const track = Buffer.from('piste 1')
    const a = await make7z(join(dir, 'src', 'Disc.7z'), { 'Disc.cue': 'FILE "Disc (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n', 'Disc (Track 1).bin': track })
    const r = await unpackArchive(a, work())
    expect(typeof r).toBe('object')
    if (typeof r === 'string') return
    expect(r.file.endsWith('.zip')).toBe(true)
    const entries = (await readZip(r.file))!.map((e) => e.name).sort()
    expect(entries).toEqual(['Disc (Track 1).bin', 'Disc.cue'])
  })
  it('.7z paquet PS Vita (dans un sous-dossier) : remis à la racine d’un .zip', async () => {
    const a = await make7z(join(dir, 'src', 'V.7z'), { 'Jeu/eboot.bin': 'boot', 'Jeu/sce_sys/param.sfo': 'sfo' })
    const r = await unpackArchive(a, work())
    expect(typeof r).toBe('object')
    if (typeof r === 'string') return
    expect((await readZip(r.file))!.map((e) => e.name).sort()).toEqual(['eboot.bin', 'sce_sys/param.sfo'])
  })
  it('.7z corrompue (tronquée) ou qui n’en est pas une : erreur explicite', async () => {
    const a = await make7z(join(dir, 'src', 'g.7z'), { 'Game.iso': Buffer.from('x'.repeat(5000) + Math.random()) })
    const full = readFileSync(a)
    const trunc = join(dir, 'src', 'trunc.7z'); writeFileSync(trunc, full.subarray(0, Math.floor(full.length / 2)))
    expect(await unpackArchive(trunc, work())).toMatch(/corrompue|échouée/)
    const fake = join(dir, 'src', 'fake.7z'); writeFileSync(fake, 'ceci n’est pas une archive')
    expect(await unpackArchive(fake, work())).toMatch(/corrompue|échouée/)
  })
  it('.7z protégée par mot de passe (contenu chiffré, ou noms chiffrés aussi) : erreur explicite', async () => {
    const a = await make7z(join(dir, 'src', 'p1.7z'), { 'Game.iso': 'secret' }, ['-psecret'])
    expect(await unpackArchive(a, work())).toMatch(/mot de passe/)
    const b = await make7z(join(dir, 'src', 'p2.7z'), { 'Game.iso': 'secret' }, ['-psecret', '-mhe=on'])
    expect(await unpackArchive(b, join(dir, 'work2'))).toMatch(/mot de passe/)
  })

  it('.rar valide : ROM unique', async () => {
    const iso = Buffer.from('rar iso '.repeat(300))
    const f = join(dir, 'src', 'game.rar'); writeFileSync(f, makeRar5([{ name: 'Game.iso', data: iso }]))
    const r = await unpackArchive(f, work())
    expect(typeof r).toBe('object')
    if (typeof r !== 'string') expect(readFileSync(r.file)).toEqual(iso)
  })
  it('.rar à plusieurs fichiers : ROM choisie parmi les annexes ; disque .cue reconditionné ; plusieurs ROM refusées', async () => {
    const f = join(dir, 'src', 'a.rar'); writeFileSync(f, makeRar5([{ name: 'readme.txt', data: Buffer.from('x') }, { name: 'Jeu.gba', data: Buffer.from('gba') }]))
    const r = await unpackArchive(f, work())
    expect(typeof r === 'object' && basename(r.file)).toBe('Jeu.gba')
    const d = join(dir, 'src', 'd.rar')
    writeFileSync(d, makeRar5([{ name: 'D.cue', data: Buffer.from('FILE "D.bin" BINARY\n') }, { name: 'D.bin', data: Buffer.from('bin') }]))
    const rd = await unpackArchive(d, join(dir, 'work2'))
    expect(typeof rd === 'object' && rd.file.endsWith('.zip')).toBe(true)
    const m = join(dir, 'src', 'm.rar')
    writeFileSync(m, makeRar5([{ name: 'a.gba', data: Buffer.from('a') }, { name: 'b.gba', data: Buffer.from('b') }]))
    expect(await unpackArchive(m, join(dir, 'work3'))).toMatch(/un seul fichier de ROM/)
  })
  it('.rar corrompue : erreur explicite', async () => {
    const buf = makeRar5([{ name: 'Game.iso', data: Buffer.from('x'.repeat(2000)) }])
    const f = join(dir, 'src', 'c.rar'); writeFileSync(f, buf.subarray(0, buf.length - 400))
    expect(await unpackArchive(f, work())).toMatch(/corrompue|échouée/)
  })
  it('.rar protégée par mot de passe : erreur explicite', async () => {
    const f = join(dir, 'src', 'p.rar'); writeFileSync(f, makeRar5([{ name: 'Game.iso', data: Buffer.from('x'.repeat(64)), encrypted: true }]))
    expect(await unpackArchive(f, work())).toMatch(/mot de passe/)
  })
  it('.rar à chemin malveillant (../, absolu, lecteur) : refusé, rien n’est écrit hors du dossier temporaire', async () => {
    for (const [i, name] of ['../evil.nes', '../../evil.nes', '/evil.nes', 'C:/evil.nes', 'ok/../../evil.nes'].entries()) {
      const f = join(dir, 'src', `evil${i}.rar`); writeFileSync(f, makeRar5([{ name, data: Buffer.from('mal') }]))
      const w = join(dir, `w${i}`)
      const r = await unpackArchive(f, w)
      expect(typeof r, name).toBe('string')
      expect(existsSync(join(dir, 'evil.nes'))).toBe(false)
      expect(existsSync(join(dir, 'src', 'evil.nes'))).toBe(false)
      expect(existsSync(join(w, 'evil.nes'))).toBe(false)
    }
  })

  it('multi-volumes .rar : complets, extraits depuis le premier ; volume manquant ou premier volume absent : erreur explicite', async () => {
    const iso = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251))
    const vols = makeRar5Volumes({ name: 'Game.iso', data: iso }, 3)
    vols.forEach((v, i) => writeFileSync(join(dir, 'src', `game.part${i + 1}.rar`), v))
    const r = await unpackArchive(join(dir, 'src', 'game.part1.rar'), work())
    expect(typeof r).toBe('object')
    if (typeof r !== 'string') {
      expect(readFileSync(r.file)).toEqual(iso)
      expect(r.volumes.map((v) => basename(v)).sort()).toEqual(['game.part1.rar', 'game.part2.rar', 'game.part3.rar'])
    }
    // Volume non initial importé seul.
    expect(await unpackArchive(join(dir, 'src', 'game.part2.rar'), join(dir, 'w2'))).toMatch(/premier volume/)
    // Volume intermédiaire manquant.
    rmSync(join(dir, 'src', 'game.part3.rar'))
    expect(await unpackArchive(join(dir, 'src', 'game.part1.rar'), join(dir, 'w3'))).toMatch(/volume est manquant|corrompue|échouée/)
    // Premier volume absent.
    rmSync(join(dir, 'src', 'game.part1.rar'))
    expect(await unpackArchive(join(dir, 'src', 'game.part2.rar'), join(dir, 'w4'))).toMatch(/premier volume manquant/)
  })
})

describe('import d’archives dans la bibliothèque', () => {
  let db: DatabaseSync
  beforeEach(() => { db = new DatabaseSync(':memory:'); migrate(db) })
  const opt = (over: object = {}) => ({ copy: true, deleteSource: false, romsDir: join(dir, 'roms'), ...over })
  const addGame = (console: string, title: string, crc: string, size: number): number =>
    Number(db.prepare('INSERT INTO catalog_games (console, title, name, crc, size, base, dup) VALUES (?, ?, ?, ?, ?, ?, 0)').run(console, title, title, crc, size, title.toLowerCase()).lastInsertRowid)
  const noTemp = (): void => { expect(existsSync(join(dir, 'roms', '.import-tmp'))).toBe(false); expect(existsSync(join(dir, 'roms', '.archive-tmp'))).toBe(false) }

  it('.7z -> extraction -> identification par hash -> bibliothèque ; temporaires nettoyés', async () => {
    const rom = Buffer.from('7z nes rom')
    const id = addGame('nes', 'Seven', hex(crc32(rom)), rom.length)
    const a = await make7z(join(dir, 'src', 'seven.7z'), { 'Seven.nes': rom })
    const r = await importPaths(db, [a], opt())
    expect(r.items[0]).toMatchObject({ file: a, status: 'added', console: 'nes', match: 'hash' })
    expect(readFileSync(join(dir, 'roms', 'nes', 'Seven.nes'))).toEqual(rom)
    expect(listLibrary(db)[0]).toMatchObject({ gameId: id, missing: false })
    expect(existsSync(a)).toBe(true) // deleteSource faux : l'archive reste
    noTemp()
  })
  it('.rar -> bibliothèque, archive supprimée si demandé', async () => {
    const rom = Buffer.from('rar snes rom')
    addGame('snes', 'Rarjeu', hex(crc32(rom)), rom.length)
    const f = join(dir, 'src', 'rarjeu.rar'); writeFileSync(f, makeRar5([{ name: 'Rarjeu.sfc', data: rom }]))
    const r = await importPaths(db, [f], opt({ deleteSource: true }))
    expect(r.items[0]).toMatchObject({ status: 'added', console: 'snes', match: 'hash' })
    expect(existsSync(f)).toBe(false)
    expect(existsSync(join(dir, 'roms', 'snes', 'Rarjeu.sfc'))).toBe(true)
    noTemp()
  })
  it('.7z disque .cue + piste -> importé comme un zip .cue (fichiers extraits à côté)', async () => {
    const track = Buffer.from('piste ps1')
    addGame('ps1', 'Disc', hex(crc32(track)), track.length)
    const a = await make7z(join(dir, 'src', 'Disc.7z'), { 'Disc.cue': 'FILE "Disc (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n', 'Disc (Track 1).bin': track })
    const r = await importPaths(db, [a], opt())
    expect(r.items[0]).toMatchObject({ status: 'added', console: 'ps1', match: 'hash' })
    expect(readFileSync(join(dir, 'roms', 'ps1', 'Disc (Track 1).bin'))).toEqual(track)
    expect(existsSync(join(dir, 'roms', 'ps1', 'Disc.cue'))).toBe(true)
    noTemp()
  })
  it('.7z paquet Vita -> gardé comme un zip dans roms/vita', async () => {
    const a = await make7z(join(dir, 'src', 'Vita.7z'), { 'eboot.bin': 'boot', 'sce_sys/param.sfo': 'sfo' })
    const r = await importPaths(db, [a], opt())
    expect(r.items[0].status).toBe('added')
    const [e] = listLibrary(db)
    expect(e.console).toBe('vita'); expect(e.path.endsWith('.zip')).toBe(true); expect(existsSync(e.path)).toBe(true)
    noTemp()
  })
  it('archives en échec (corrompue, mot de passe, plusieurs ROM, traversal) : erreur par fichier, rien dans la bibliothèque, aucun temporaire', async () => {
    const bad1 = join(dir, 'src', 'bad1.7z'); writeFileSync(bad1, 'pas une archive')
    const bad2 = await make7z(join(dir, 'src', 'bad2.7z'), { 'a.nes': 'a' }, ['-psecret'])
    const bad3 = await make7z(join(dir, 'src', 'bad3.7z'), { 'a.nes': 'aa', 'b.nes': 'bb' })
    const bad4 = join(dir, 'src', 'bad4.rar'); writeFileSync(bad4, makeRar5([{ name: '../x.nes', data: Buffer.from('x') }]))
    const r = await importPaths(db, [bad1, bad2, bad3, bad4], opt())
    expect(r.items.map((i) => i.status)).toEqual(['error', 'error', 'error', 'error'])
    expect(r.items.every((i) => !!i.error)).toBe(true)
    expect(listLibrary(db)).toHaveLength(0)
    expect(existsSync(join(dir, 'x.nes'))).toBe(false)
    noTemp()
  })
  it('volumes .rar : n’importe jamais un volume seul ; le jeu complet est importé une seule fois', async () => {
    const rom = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7) % 256))
    addGame('gba', 'Gros', hex(crc32(rom)), rom.length)
    const vols = makeRar5Volumes({ name: 'Gros.gba', data: rom }, 2)
    const files = vols.map((v, i) => { const f = join(dir, 'src', `gros.part${i + 1}.rar`); writeFileSync(f, v); return f })
    // Dossier entier : les deux volumes sont vus, un seul import.
    const r = await importPaths(db, [join(dir, 'src')], opt({ deleteSource: true }))
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ status: 'added', console: 'gba', match: 'hash' })
    expect(files.every((f) => !existsSync(f))).toBe(true) // tous les volumes supprimés
    // Volume 2 seul, sans le premier : erreur claire, jamais importé comme archive indépendante.
    const lone = join(dir, 'src2', 'x.part2.rar'); mkdirSync(join(dir, 'src2'), { recursive: true }); writeFileSync(lone, vols[1])
    const r2 = await importPaths(db, [lone], opt())
    expect(r2.items).toHaveLength(1)
    expect(r2.items[0].status).toBe('error'); expect(r2.items[0].error).toMatch(/premier volume/)
    expect(listLibrary(db)).toHaveLength(1)
    noTemp()
  })
  it('un volume incomplet (volume manquant) échoue avec une erreur explicite', async () => {
    const vols = makeRar5Volumes({ name: 'Gros.gba', data: Buffer.from('x'.repeat(4000)) }, 3)
    const f1 = join(dir, 'src', 'g.part1.rar'); writeFileSync(f1, vols[0]); writeFileSync(join(dir, 'src', 'g.part3.rar'), vols[2])
    const r = await importPaths(db, [f1], opt())
    expect(r.items[0].status).toBe('error')
    expect(listLibrary(db)).toHaveLength(0)
    noTemp()
  })
  it('zip existant : aucun changement de comportement (un .zip n’est jamais envoyé au moteur 7z)', async () => {
    expect(archiveVolume(join(dir, 'x.zip'))).toBeNull()
    const f = join(dir, 'src', 'not.zip'); writeFileSync(f, 'pas un zip')
    expect((await importPaths(db, [f], opt())).items[0]).toMatchObject({ status: 'error', error: 'archive illisible' })
    expect(readdirSync(join(dir, 'src'))).toContain('not.zip')
  })
})

describe('installDownload avec archive', () => {
  it('téléchargement .7z : hash déclaré = celui de l’archive brute, ROM extraite, identifiée et installée ; archive et temporaires supprimés', async () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    const rom = Buffer.from('rom du jeu téléchargé')
    const gid = Number(db.prepare('INSERT INTO catalog_games (console, title, name, crc, size, base, dup) VALUES (?, ?, ?, ?, ?, ?, 0)').run('nes', 'Dl', 'Dl', hex(crc32(rom)), rom.length, 'dl').lastInsertRowid)
    db.prepare("INSERT INTO source_lists (id, name, url, added_at) VALUES (1, 'L', 'https://x/l.json', 0)").run()
    db.prepare("INSERT INTO sources (id, list_id, game_id, console, title, uris) VALUES (1, 1, ?, 'nes', 'Dl', '[]')").run(gid)
    const a = await make7z(join(dir, 'src', 'dl.7z'), { 'Dl.nes': rom })
    const res = await installDownload(db, 1, a, { roms: join(dir, 'roms') } as never)
    expect(res).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'roms', 'nes', 'Dl.nes'))).toEqual(rom)
    expect(listLibrary(db)[0]).toMatchObject({ gameId: gid, match: 'hash' })
    expect(existsSync(a)).toBe(false)
    expect(existsSync(join(dir, 'roms', '.archive-tmp'))).toBe(false)
  })
  it('téléchargement .rar corrompu : erreur renvoyée, rien d’installé, aucun temporaire', async () => {
    const db = new DatabaseSync(':memory:'); migrate(db)
    const gid = Number(db.prepare('INSERT INTO catalog_games (console, title, name, crc, size, base, dup) VALUES (?, ?, ?, ?, ?, ?, 0)').run('nes', 'Dl', 'Dl', 'AAAAAAAA', 3, 'dl').lastInsertRowid)
    db.prepare("INSERT INTO source_lists (id, name, url, added_at) VALUES (1, 'L', 'https://x/l.json', 0)").run()
    db.prepare("INSERT INTO sources (id, list_id, game_id, console, title, uris) VALUES (1, 1, ?, 'nes', 'Dl', '[]')").run(gid)
    const f = join(dir, 'src', 'dl.rar'); writeFileSync(f, 'Rar!\x1a\x07\x01\x00 corrompu')
    const res = await installDownload(db, 1, f, { roms: join(dir, 'roms') } as never)
    expect(res.ok).toBe(false); expect(res.error).toMatch(/corrompue|échouée/)
    expect(listLibrary(db)).toHaveLength(0)
    expect(existsSync(join(dir, 'roms', '.archive-tmp'))).toBe(false)
  })
})
