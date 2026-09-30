import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const addSource = (gameId: number | null): number => {
  db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('L', 'https://x/l.json', 0)").run()
  db.prepare("INSERT INTO sources (list_id, game_id, console, title, uris, matched) VALUES (1, ?, 'nes', 'Test', '[]', ?)").run(gameId, gameId !== null ? 1 : 0)
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
}

const downloadedFile = (name: string, content: string): string => {
  const dl = join(dir, 'dl')
  mkdirSync(dl, { recursive: true })
  const f = join(dl, name)
  writeFileSync(f, content)
  return f
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

  it("refuse un fichier dont le hash ne correspond pas, sans rien installer", async () => {
    const gameId = addGame('cbf43926')
    const sourceId = addSource(gameId)
    const file = downloadedFile('Test.nes', 'ceci ne correspond pas du tout')

    const result = await installDownload(db, sourceId, file, paths)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/hash/)
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
})
