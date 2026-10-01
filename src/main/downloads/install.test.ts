import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import type { AppPaths } from '@shared/ipc'
import { migrate } from '../db/migrations'
import { listLibrary } from '../library/libraryStore'
import { installDownload } from './install'

let dir: string
let db: DatabaseSync
let paths: AppPaths
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rv-install-'))
  db = new DatabaseSync(':memory:')
  migrate(db)
  paths = { dataDir: dir, roms: join(dir, 'roms'), emulators: join(dir, 'emulators'), bios: join(dir, 'bios'), saves: join(dir, 'saves'), cache: join(dir, 'cache'), dats: join(dir, 'dats'), logs: join(dir, 'logs') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// « 123456789 » → crc cbf43926, 9 octets (fixture connue, voir library.test.ts).
const addGame = (crc: string | null): number =>
  Number(db.prepare("INSERT INTO catalog_games (console, title, name, crc, size) VALUES ('nes', 'Test (Europe)', 'Test', ?, 9)").run(crc).lastInsertRowid)

const addSource = (gameId: number | null, hash: { crc?: string; sha1?: string } = {}): number => {
  db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('L', 'https://x/l.json', 0)").run()
  db.prepare("INSERT INTO sources (list_id, game_id, console, title, crc, sha1, uris, matched) VALUES (1, ?, 'nes', 'Test', ?, ?, '[]', ?)")
    .run(gameId, hash.crc ?? null, hash.sha1 ?? null, gameId !== null ? 1 : 0)
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}

const downloadedFile = (name: string, content: string | Buffer): string => {
  const dl = join(dir, 'dl')
  mkdirSync(dl, { recursive: true })
  const f = join(dl, name)
  writeFileSync(f, content)
  return f
}

const hex = (n: number): string => (n >>> 0).toString(16).toUpperCase().padStart(8, '0')

/** Zip minimal (une entrée compressée) : le hash d'une liste de sources porte sur ce fichier .zip tel quel, pas sur la ROM qu'il contient (voir le commentaire d'installDownload). */
function makeZip(name: string, data: Buffer): Buffer {
  const comp = deflateRawSync(data), nm = Buffer.from(name), entryCrc = crc32(data)
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
  lh.writeUInt32LE(entryCrc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26)
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10)
  cd.writeUInt32LE(entryCrc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28)
  const local = Buffer.concat([lh, nm, comp])
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(cd.length + nm.length, 12); eocd.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, cd, nm, eocd])
}

describe('installDownload', () => {
  it('installe un fichier dont le hash correspond au jeu attendu', async () => {
    const gameId = addGame('cbf43926')
    const sourceId = addSource(gameId)
    const file = downloadedFile('Test.nes', '123456789')

    const result = await installDownload(db, sourceId, file, paths)
    expect(result).toEqual({ ok: true })
    const [entry] = listLibrary(db)
    expect(entry).toMatchObject({ gameId, match: 'hash', missing: false })
    expect(existsSync(entry.path)).toBe(true)
    expect(existsSync(file)).toBe(false) // déplacé, pas laissé dans le cache de téléchargement
  })

  it("installe quand même un fichier dont le hash ne correspond à rien de vérifiable (liste sans hash déclaré), rattaché au jeu déjà associé par la liste", async () => {
    const gameId = addGame('cbf43926')
    const sourceId = addSource(gameId) // pas de crc/sha1 déclaré par la liste : rien à vérifier
    const file = downloadedFile('Test.nes', 'ceci ne correspond pas du tout')

    const result = await installDownload(db, sourceId, file, paths)
    expect(result).toEqual({ ok: true })
    const [entry] = listLibrary(db)
    expect(entry).toMatchObject({ gameId, console: 'nes', title: 'Test', match: 'unverified', missing: false })
    expect(existsSync(file)).toBe(false) // déplacé, pas laissé dans le cache de téléchargement
  })

  it("installe un fichier dont le hash ne correspond pas au catalogue (ROM patchée, DAT officiel différent) mais correspond à celui déclaré par la liste de sources", async () => {
    const gameId = addGame('AAAAAAAA') // hash du DAT officiel : volontairement différent du fichier patché téléchargé
    const sourceId = addSource(gameId, { crc: 'cbf43926' }) // la liste déclare le hash du fichier patché qu'elle distribue
    const file = downloadedFile('Test_apfix.nes', '123456789')

    const result = await installDownload(db, sourceId, file, paths)
    expect(result).toEqual({ ok: true })
    const [entry] = listLibrary(db)
    expect(entry).toMatchObject({ gameId, console: 'nes', title: 'Test', match: 'source', missing: false })
  })

  it("installe une archive .zip dont le hash déclaré par la liste de sources porte sur le .zip lui-même, pas sur la ROM qu'il contient (cas réel : nds_apfix.romvault.json)", async () => {
    const gameId = addGame('AAAAAAAA') // hash du DAT officiel : ne correspond ni au zip ni à l'entrée qu'il contient
    const zip = makeZip('Test.nes', Buffer.from('123456789')) // l'entrée interne a son propre crc (cbf43926), différent du crc du zip entier
    // La liste déclare le hash du .zip TEL QUE TÉLÉCHARGÉ (son contenu brut), comme le fait vraiment nds_apfix.romvault.json.
    const sourceId = addSource(gameId, { crc: hex(crc32(zip)), sha1: createHash('sha1').update(zip).digest('hex') })
    const file = downloadedFile('Test_apfix.zip', zip)

    const result = await installDownload(db, sourceId, file, paths)
    expect(result).toEqual({ ok: true })
    const [entry] = listLibrary(db)
    expect(entry).toMatchObject({ gameId, console: 'nes', title: 'Test', match: 'source', missing: false })
  })

  it("installe quand même un fichier dont le hash ne correspond ni au catalogue ni à celui déclaré par la liste de sources (empreinte déclarée probablement erronée, pas une preuve que ce soit le mauvais jeu)", async () => {
    const gameId = addGame('AAAAAAAA')
    const sourceId = addSource(gameId, { crc: 'BBBBBBBB' })
    const file = downloadedFile('Test.nes', '123456789')

    const result = await installDownload(db, sourceId, file, paths)
    expect(result).toEqual({ ok: true })
    const [entry] = listLibrary(db)
    expect(entry).toMatchObject({ gameId, console: 'nes', title: 'Test', match: 'unverified', missing: false })
  })

  it("refuse un fichier dont l'empreinte officielle identifie sans ambiguïté un AUTRE jeu du catalogue (preuve positive, pas une simple absence de preuve)", async () => {
    const gameId = addGame('cbf43926') // jeu attendu par la source, empreinte '123456789'
    const otherContent = 'un autre jeu'
    db.prepare("INSERT INTO catalog_games (console, title, name, crc, size) VALUES ('nes', 'Autre (Europe)', 'Autre', ?, ?)")
      .run(hex(crc32(Buffer.from(otherContent))), Buffer.byteLength(otherContent))
    const sourceId = addSource(gameId)
    // Le fichier téléchargé est en réalité un AUTRE jeu du catalogue, reconnu par empreinte officielle.
    const file = downloadedFile('Test.nes', otherContent)

    const result = await installDownload(db, sourceId, file, paths)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/autre jeu/)
    expect(listLibrary(db)).toHaveLength(0)
    expect(existsSync(file)).toBe(true) // conservé pour inspection, pas supprimé silencieusement
  })

  it('signale une archive corrompue sans planter ni rien installer', async () => {
    const gameId = addGame('cbf43926')
    const sourceId = addSource(gameId)
    const file = downloadedFile('Test.zip', 'pas un vrai zip')

    const result = await installDownload(db, sourceId, file, paths)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(listLibrary(db)).toHaveLength(0)
  })

  it('refuse une source sans jeu associé (non rapprochée du catalogue)', async () => {
    const sourceId = addSource(null)
    const file = downloadedFile('Test.nes', '123456789')
    const result = await installDownload(db, sourceId, file, paths)
    expect(result).toEqual({ ok: false, error: 'aucun jeu du catalogue associé à cette source' })
  })

  it('source introuvable : erreur claire', async () => {
    const file = downloadedFile('Test.nes', '123456789')
    expect(await installDownload(db, 999, file, paths)).toEqual({ ok: false, error: 'source introuvable' })
  })

  it('renvoie une erreur (jamais une exception non attrapée) si le fichier téléchargé a disparu entre-temps', async () => {
    const gameId = addGame('cbf43926')
    const sourceId = addSource(gameId)
    const file = join(dir, 'dl', 'disparu.nes') // jamais écrit : lève ENOENT à la lecture

    const result = await installDownload(db, sourceId, file, paths) // ne doit jamais rejeter
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(listLibrary(db)).toHaveLength(0)
  })
})
