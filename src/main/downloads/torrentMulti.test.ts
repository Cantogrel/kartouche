import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AppPaths } from '@shared/ipc'
import { migrate } from '../db/migrations'
import { nspWithXml } from '../library/content/content.testutil'
import { listContent, listLibrary } from '../library/libraryStore'
import { downloadSource, type HttpFetch } from './engine'
import { installDownload } from './install'
import { setTorrentClientOptions } from './torrent'

// Réseau 100 % local (voir torrent.test.ts) : un torrent à plusieurs fichiers, dont RomVault ne doit récupérer et installer que ce qui sert au jeu.
const LOCAL = { dht: false, tracker: true, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false }
let seeder: {
  seed(input: string | string[], opts: object, cb: (t: { magnetURI: string; torrentFile: Buffer }) => void): void
  destroy(cb: () => void): void
  torrentPort: number
}
let tracker: { listen(port: number, host: string, cb: () => void): void; http: { address(): { port: number } }; close(cb: () => void): void }
let announce = ''
let work: string, cache: string, dir: string
let db: DatabaseSync
let paths: AppPaths

beforeAll(async () => {
  const { default: WebTorrent } = (await import('webtorrent')) as unknown as { default: new (o: object) => typeof seeder }
  const { Server } = (await import('bittorrent-tracker')) as unknown as { Server: new (o: object) => typeof tracker }
  tracker = new Server({ udp: false, ws: false, http: true, stats: false })
  await new Promise<void>((r) => tracker.listen(0, '127.0.0.1', r))
  announce = `http://127.0.0.1:${tracker.http.address().port}/announce`
  seeder = new WebTorrent(LOCAL)
  setTorrentClientOptions(LOCAL)
  await new Promise((r) => setTimeout(r, 200))
})
afterAll(async () => { await new Promise<void>((r) => seeder.destroy(r)); await new Promise<void>((r) => tracker.close(r)) })
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'rv-multi-src-')); cache = mkdtempSync(join(tmpdir(), 'rv-multi-cache-')); dir = mkdtempSync(join(tmpdir(), 'rv-multi-lib-'))
  db = new DatabaseSync(':memory:'); migrate(db)
  paths = { dataDir: dir, roms: join(dir, 'roms'), emulators: join(dir, 'emulators'), bios: join(dir, 'bios'), saves: join(dir, 'saves'), cache: join(dir, 'cache'), dats: join(dir, 'dats'), logs: join(dir, 'logs') }
})
afterEach(() => { for (const d of [work, cache, dir]) rmSync(d, { recursive: true, force: true }) })

const make = (rel: string, data: Buffer | string): void => { const f = join(work, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, data) }
const seed = (root: string): Promise<Buffer> => new Promise((resolve) => seeder.seed(join(work, root), { name: root, path: work, announce: [announce] }, (t) => resolve(t.torrentFile)))
const torrentFetch = (file: Buffer): HttpFetch => async () => new Response(new Uint8Array(file), { status: 200 })
const addSource = (consoleId: string, title: string): number => {
  db.prepare('INSERT INTO catalog_games (console, title, name) VALUES (?, ?, ?)').run(consoleId, title, title)
  db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('L', 'https://x/l.json', 0)").run()
  db.prepare('INSERT INTO sources (list_id, game_id, console, title, uris, matched) VALUES (1, 1, ?, ?, ?, 1)').run(consoleId, title, JSON.stringify(['https://x/p.torrent']))
  return 1
}
/** Octets présents sur le disque pour un fichier du torrent qu'on n'a pas demandé (0 s'il n'existe pas). */
const partOf = (d: string, name: string, _full: number): number => {
  const hit = readdirSync(d, { recursive: true, withFileTypes: true }).find((e) => e.isFile() && e.name === name)
  return hit ? statSync(join(hit.parentPath, hit.name)).size : 0
}
const allFiles = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)

describe('torrent multi-fichiers → bibliothèque', () => {
  it('disque PS1 : le .cue et SES pistes seulement (ni l’autre jeu, ni les images, ni les notices), installés ensemble', async () => {
    const [t1, t2] = [randomBytes(120_000), randomBytes(60_000)]
    make('Pack/Game (USA)/Game (USA).cue', 'FILE "Game (USA) (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\nFILE "Game (USA) (Track 2).bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n')
    make('Pack/Game (USA)/Game (USA) (Track 1).bin', t1)
    make('Pack/Game (USA)/Game (USA) (Track 2).bin', t2)
    make('Pack/Other (USA)/Other (USA).cue', 'FILE "Other (USA).bin" BINARY\n')
    make('Pack/Other (USA)/Other (USA).bin', randomBytes(90_000))
    make('Pack/cover.jpg', randomBytes(5_000)); make('Pack/readme.nfo', 'infos')
    const id = addSource('ps1', 'Game (USA)')
    const r = await downloadSource(db, id, cache, () => {}, torrentFetch(await seed('Pack')))
    expect(r.error).toBeUndefined()
    expect(r.files!.map((p) => basename(p))).toEqual(['Game (USA).cue', 'Game (USA) (Track 1).bin', 'Game (USA) (Track 2).bin'])
    // L'autre jeu n'est pas demandé : au pire quelques octets débordent des pièces voisines (une pièce BitTorrent chevauche deux fichiers), jamais le fichier.
    expect(partOf(join(cache, '1'), 'Other (USA).bin', 90_000)).toBeLessThan(90_000)

    const result = await installDownload(db, id, r.file!, paths, r.files!.slice(1))
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(listLibrary(db)).toHaveLength(1)
    expect(listLibrary(db)[0]).toMatchObject({ console: 'ps1', gameId: 1 })
    expect(allFiles(join(paths.roms, 'ps1')).sort()).toEqual(['Game (USA) (Track 1).bin', 'Game (USA) (Track 2).bin', 'Game (USA).cue'])
  })

  it('jeu Switch : le jeu, SA mise à jour et SON DLC — pas l’autre jeu ni sa mise à jour', async () => {
    make('Pack/Game [0100000000010000][v0].nsp', nspWithXml('base', '0100000000010000', 0, undefined, 'a'.repeat(50_000)))
    make('Pack/Game [0100000000010800][v65536].nsp', nspWithXml('update', '0100000000010800', 65536, '0100000000010000', 'b'.repeat(40_000)))
    make('Pack/Game DLC [0100000000011001][v0].nsp', nspWithXml('dlc', '0100000000011001', 0, '0100000000010000', 'c'.repeat(30_000)))
    make('Pack/Other [0100000000020000][v0].nsp', nspWithXml('base', '0100000000020000', 0, undefined, 'd'.repeat(50_000)))
    make('Pack/Other [0100000000020800][v131072].nsp', nspWithXml('update', '0100000000020800', 131072, '0100000000020000', 'e'.repeat(40_000)))
    make('Pack/readme.txt', 'x')
    const id = addSource('switch', 'Game')
    const r = await downloadSource(db, id, cache, () => {}, torrentFetch(await seed('Pack')))
    expect(r.error).toBeUndefined()
    expect(r.files!.map((p) => basename(p)).sort()).toEqual(['Game DLC [0100000000011001][v0].nsp', 'Game [0100000000010000][v0].nsp', 'Game [0100000000010800][v65536].nsp'])
    expect(basename(r.file!)).toBe('Game [0100000000010000][v0].nsp')
    expect(partOf(join(cache, '1'), 'Other [0100000000020000][v0].nsp', statSync(join(work, 'Pack', 'Other [0100000000020000][v0].nsp')).size)).toBeLessThan(statSync(join(work, 'Pack', 'Other [0100000000020000][v0].nsp')).size)

    const result = await installDownload(db, id, r.file!, paths, r.files!.slice(1))
    expect(result.ok).toBe(true)
    expect(result.notes).toBeUndefined()
    expect(listLibrary(db)).toHaveLength(1) // le jeu seul : mise à jour et DLC rattachés, jamais des lignes de bibliothèque
    expect(listContent(db, 1).map((c) => c.kind).sort()).toEqual(['dlc', 'update'])
    expect(existsSync(join(paths.roms, 'switch', '.content', '0100000000010000'))).toBe(true)
  })

  it('un fichier dont le nom laissait croire qu’il était du jeu mais qui appartient à un autre : refusé par l’import (noté), le jeu est installé', async () => {
    make('Pack/Game.nsp', nspWithXml('base', '0100000000010000', 0, undefined, 'a'.repeat(30_000)))
    // Même préfixe de nom, mais le fichier est la mise à jour D'UN AUTRE jeu.
    make('Pack/Game Update v2.nsp', nspWithXml('update', '0100000000020800', 2, '0100000000020000', 'z'.repeat(30_000)))
    const id = addSource('switch', 'Game')
    const r = await downloadSource(db, id, cache, () => {}, torrentFetch(await seed('Pack')))
    expect(r.files).toHaveLength(2)
    const result = await installDownload(db, id, r.file!, paths, r.files!.slice(1))
    expect(result.ok).toBe(true)
    expect(result.notes).toHaveLength(1)
    expect(listLibrary(db)).toHaveLength(1)
    expect(listContent(db, 1)).toHaveLength(0)
  })
})
