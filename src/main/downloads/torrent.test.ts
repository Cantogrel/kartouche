import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DownloadProgress } from '@shared/downloads'
import type { AppPaths } from '@shared/ipc'
import { migrate } from '../db/migrations'
import { makeWuaFiles } from '../library/content/emu.testutil'
import { VWII_REASON } from '../library/content/wua'
import { listLibrary } from '../library/libraryStore'
import { cancelDownload, downloadSource, type HttpFetch } from './engine'
import { installDownload } from './install'
import { downloadTorrent, fileBytesDone, pickTorrentFile, setTorrentClientOptions, torrentKey, uriKind } from './torrent'

// Réseau 100 % local : un client WebTorrent « semeur » sur 127.0.0.1, aucun tracker/DHT/pair public, aucun contenu réel.
const LOCAL = { dht: false, tracker: true, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false }

interface Seeded { magnet: string; torrentFile: Buffer }
let seeder: {
  seed(input: string | string[], opts: object, cb: (t: { magnetURI: string; torrentFile: Buffer }) => void): void
  destroy(cb: () => void): void
  torrentPort: number
  throttleUpload(rate: number): void
}
let tracker: { listen(port: number, host: string, cb: () => void): void; http: { address(): { port: number } }; close(cb: () => void): void }
let announce = ''
let work: string
let cache: string

beforeAll(async () => {
  const { default: WebTorrent } = (await import('webtorrent')) as unknown as { default: new (o: object) => typeof seeder }
  const { Server } = (await import('bittorrent-tracker')) as unknown as { Server: new (o: object) => typeof tracker }
  tracker = new Server({ udp: false, ws: false, http: true, stats: false })
  await new Promise<void>((r) => tracker.listen(0, '127.0.0.1', r))
  announce = `http://127.0.0.1:${tracker.http.address().port}/announce`
  seeder = new WebTorrent(LOCAL)
  setTorrentClientOptions(LOCAL)
  await new Promise((r) => setTimeout(r, 200)) // laisse le port d'écoute se lier
})
afterAll(async () => { await new Promise<void>((r) => seeder.destroy(r)); await new Promise<void>((r) => tracker.close(r)) })
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-tor-src-')); cache = mkdtempSync(join(tmpdir(), 'rv-tor-cache-')) })
afterEach(() => { rmSync(work, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }) })

function seed(input: string | string[], name: string): Promise<Seeded> {
  return new Promise((resolve) => seeder.seed(input, { name, path: work, announce: [announce] }, (t) => resolve({
    magnet: `${t.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`, torrentFile: t.torrentFile
  })))
}
const makeFile = (rel: string, data: Buffer): string => {
  const f = join(work, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, data)
  return f
}

let db: DatabaseSync
const addSource = (title: string, uris: string[], size: number | null = null): number => {
  db = new DatabaseSync(':memory:')
  migrate(db)
  db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('L', 'https://x/l.json', 0)").run()
  db.prepare("INSERT INTO sources (list_id, console, title, size_bytes, uris) VALUES (1, 'nes', ?, ?, ?)").run(title, size, JSON.stringify(uris))
  return 1
}
const torrentFetch = (file: Buffer): HttpFetch => async () => new Response(new Uint8Array(file), { status: 200 })

describe('uriKind', () => {
  it('détecte magnet, .torrent et HTTP classique', () => {
    expect(uriKind('magnet:?xt=urn:btih:abc')).toBe('magnet')
    expect(uriKind('MAGNET:?xt=urn:btih:abc')).toBe('magnet')
    expect(uriKind('https://example.com/game.torrent')).toBe('torrent')
    expect(uriKind('http://example.com/a/Game.TORRENT?x=1')).toBe('torrent')
    expect(uriKind('https://example.com/files/sample-game.zip')).toBe('http')
    expect(uriKind('pas une url')).toBe('http')
  })
})

describe('fileBytesDone', () => {
  const bits = (set: number[]): { get(i: number): boolean } => ({ get: (i) => set.includes(i) })
  it('fichier finissant pile sur une frontière de pièce : jamais négatif', () => {
    // 4 pièces de 10 : fichier = octets 10..40 (3 pièces entières), pièces 1 et 2 vérifiées
    const t = { bitfield: bits([1, 2]), pieces: [null, null, null, { missing: 10 }], pieceLength: 10, lastPieceLength: 10 }
    expect(fileBytesDone(t, { offset: 10, length: 30 })).toBe(20)
  })
  it('compte la part en cours et reste borné', () => {
    const t = { bitfield: bits([]), pieces: [{ missing: 5 }, { missing: 10 }], pieceLength: 10, lastPieceLength: 4 }
    expect(fileBytesDone(t, { offset: 0, length: 14 })).toBe(5)
    expect(fileBytesDone({ ...t, bitfield: bits([0, 1]) }, { offset: 0, length: 14 })).toBe(14)
  })
})

describe('pickTorrentFile', () => {
  const f = (name: string, length: number): { name: string; length: number } => ({ name, length })
  it('un seul fichier : lui', () => expect(pickTorrentFile([f('a.bin', 5)], 'X', null)).toBe(0))
  it('départage par taille déclarée', () => {
    expect(pickTorrentFile([f('a.sfc', 100), f('b.sfc', 200)], 'Zzz', 200)).toBe(1)
  })
  it('départage par titre, en ignorant ponctuation, casse et extension', () => {
    const files = [f('Other Game (USA).sfc', 10), f('super mario world (USA).sfc', 10), f('readme.txt', 1)]
    expect(pickTorrentFile(files, 'Super Mario World (USA)', null)).toBe(1)
  })
  it('ignore les fichiers annexes (.nfo, .txt…)', () => expect(pickTorrentFile([f('game.nes', 10), f('info.nfo', 1)], 'Autre', null)).toBe(0))
  it('ambigu : null plutôt que le premier fichier', () => {
    expect(pickTorrentFile([f('a.sfc', 10), f('b.sfc', 10)], 'Rien à voir', null)).toBeNull()
  })
})

describe('torrentKey', () => {
  it('infohash d’un magnet (hexadécimal ou base32, casse indifférente), empreinte d’un .torrent, null sinon', () => {
    expect(torrentKey('magnet:?xt=urn:btih:0123456789ABCDEF0123456789abcdef01234567&dn=x')).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(torrentKey('magnet:?dn=x&xt=urn:btih:5df8edfc6cd1641ae6e10131949ba2ee55b24e69&so=3')).toBe('5df8edfc6cd1641ae6e10131949ba2ee55b24e69')
    expect(torrentKey('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe('0'.repeat(40))
    expect(torrentKey(Buffer.from('abc'))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(torrentKey('magnet:?dn=sans-hash')).toBeNull()
  })
})

describe('downloadSource — BitTorrent', () => {
  it('magnet mono-fichier : téléchargement, progression, nettoyage', async () => {
    const data = randomBytes(300_000)
    const t = await seed(makeFile('single/game.nes', data), 'game.nes')
    const id = addSource('Game', [t.magnet])
    const progress: DownloadProgress[] = []
    const r = await downloadSource(db, id, cache, (p) => progress.push(p))
    expect(r.error).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(readFileSync(r.file!)).toEqual(data)
    expect(readdirSync(join(cache, '1'))).toEqual(['game.nes']) // dossier de travail du client supprimé
    expect(progress.some((p) => p.phase === 'downloading' && p.total === data.length && p.done > 0)).toBe(true)
    expect(progress.every((p) => p.done >= 0 && (p.total === 0 || p.done <= p.total))).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'done' })
  })

  it('URL .torrent multi-fichiers : récupère seulement le fichier du jeu (titre + taille), pas les autres', async () => {
    const wanted = randomBytes(200_000), other = randomBytes(150_000)
    makeFile('Pack/Mario (USA).sfc', wanted)
    makeFile('Pack/Zelda (USA).sfc', other)
    makeFile('Pack/readme.txt', Buffer.from('lisez-moi'))
    const t = await seed(join(work, 'Pack'), 'Pack')
    const id = addSource('Mario (USA)', ['https://x/pack.torrent'], wanted.length)
    const r = await downloadSource(db, id, cache, () => {}, torrentFetch(t.torrentFile))
    expect(r.error).toBeUndefined()
    expect(readFileSync(r.file!)).toEqual(wanted)
    expect(readdirSync(join(cache, '1'))).toEqual(['Mario (USA).sfc'])
  })

  it('deux jeux d’une même collection téléchargés en même temps (même torrent) : les deux réussissent, aucun n’abat l’autre', async () => {
    const a = randomBytes(300_000), b = randomBytes(250_000)
    makeFile('Pack/Mario (USA).sfc', a)
    makeFile('Pack/Zelda (USA).sfc', b)
    const t = await seed(join(work, 'Pack'), 'Pack')
    const run = (title: string, size: number, dir: string): Promise<string[]> => downloadTorrent({ input: t.magnet, workDir: join(cache, dir), title, sizeBytes: size, consoleId: 'snes', signal: new AbortController().signal, onProgress: () => {} })
    const [ra, rb] = await Promise.all([run('Mario (USA)', a.length, 'w1'), run('Zelda (USA)', b.length, 'w2')])
    expect(readFileSync(ra[0])).toEqual(a)
    expect(readFileSync(rb[0])).toEqual(b)
    // Et une seconde fois de suite : le client partagé est réutilisable après les deux.
    const again = await run('Mario (USA)', a.length, 'w3')
    expect(readFileSync(again[0])).toEqual(a)
  })

  it('torrent multi-fichiers ambigu : erreur claire, rien téléchargé', async () => {
    makeFile('Pack/a.sfc', randomBytes(100_000))
    makeFile('Pack/b.sfc', randomBytes(100_000))
    const t = await seed(join(work, 'Pack'), 'Pack')
    const id = addSource('Introuvable', [t.magnet])
    const r = await downloadSource(db, id, cache, () => {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/impossible de déterminer/)
  })

  it('annulation en cours de route : nettoyage complet', async () => {
    const t = await seed(makeFile('big/big.nes', randomBytes(3_000_000)), 'big.nes')
    seeder.throttleUpload(400_000)
    try {
      const id = addSource('Big', [t.magnet])
      let started = false
      const p = downloadSource(db, id, cache, (pr) => { if (pr.phase === 'downloading' && pr.done > 0) started = true })
      for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 50))
      expect(started).toBe(true)
      cancelDownload(id)
      const r = await p
      expect(r).toEqual({ ok: false, error: 'annulé' })
      expect(existsSync(join(cache, '1', 'torrent-0'))).toBe(false)
    } finally { seeder.throttleUpload(-1) }
  })

  it('passe à la source suivante si la première échoue', async () => {
    const data = randomBytes(50_000)
    const t = await seed(makeFile('ok/ok.nes', data), 'ok.nes')
    const id = addSource('Ok', ['https://x/mort.zip', t.magnet])
    const httpFetch: HttpFetch = async () => { throw new Error('DNS') }
    const r = await downloadSource(db, id, cache, () => {}, httpFetch)
    expect(r.ok).toBe(true)
  })

  it('magnet sans aucun pair : échoue sur le délai des métadonnées', async () => {
    const ac = new AbortController()
    await expect(downloadTorrent({
      input: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', workDir: join(cache, 'w'), title: 'X', sizeBytes: null,
      signal: ac.signal, onProgress: () => {}, metadataTimeoutMs: 800
    })).rejects.toThrow(/métadonnées/)
  })
})

describe('Wii U : titre Wii (vWii) emballé — jamais téléchargé', () => {
  const T = '00050000101bff00_v0'
  const vwii = (lead = 0): Buffer => makeWuaFiles([`${T}/code/app.xml`, `${T}/code/frisbiiU.rpx`, `${T}/code/fw.img`, `${T}/content/hif_000000.nfs`, `${T}/meta/meta.xml`], lead)
  const normal = (): Buffer => makeWuaFiles([`${T}/code/app.xml`, `${T}/code/Game.rpx`, `${T}/content/data.bin`, `${T}/meta/meta.xml`])
  const wiiuSource = (title: string, uris: string[]): number => {
    db = new DatabaseSync(':memory:')
    migrate(db)
    db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('L', 'https://x/l.json', 0)").run()
    db.prepare("INSERT INTO sources (list_id, console, title, uris) VALUES (1, 'wiiu', ?, ?)").run(title, JSON.stringify(uris))
    return 1
  }
  /** Serveur HTTP simulé avec requêtes « Range » ; compte les octets réellement servis. */
  const server = (file: Buffer): { fetch: HttpFetch; served: () => number } => {
    let served = 0
    return {
      served: () => served,
      fetch: async (_url, init) => {
        const m = /bytes=(\d+)-(\d*)/.exec(init.headers['range'] ?? '')
        if (!m) { served += file.length; return new Response(new Uint8Array(file), { status: 200, headers: { 'content-length': String(file.length) } }) }
        const a = Number(m[1]), b = m[2] === '' ? file.length - 1 : Math.min(Number(m[2]), file.length - 1)
        const part = file.subarray(a, b + 1); served += part.length
        return new Response(new Uint8Array(part), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${file.length}`, 'content-length': String(part.length) } })
      }
    }
  }

  it('HTTP : un .wua vWii est refusé avant téléchargement (quelques octets de fin seulement) ; un .wua normal se télécharge', async () => {
    const bad = server(vwii(2_000_000))
    const id = wiiuSource('Mario Galaxy', ['https://x/Mario%20Galaxy.wua'])
    const r = await downloadSource(db, id, cache, () => {}, bad.fetch)
    expect(r).toEqual({ ok: false, error: VWII_REASON })
    expect(bad.served()).toBeLessThan(10_000)
    expect(existsSync(join(cache, '1', 'Mario Galaxy.wua.part'))).toBe(false)
    const ok = server(normal())
    const id2 = wiiuSource('Jeu', ['https://x/Jeu.wua'])
    const r2 = await downloadSource(db, id2, cache, () => {}, ok.fetch)
    expect(r2.ok).toBe(true)
  })

  it('HTTP sans prise en charge de « Range » : aucun blocage (l’import tranchera)', async () => {
    const file = vwii()
    const noRange: HttpFetch = async () => new Response(new Uint8Array(file), { status: 200, headers: { 'content-length': String(file.length) } })
    const id = wiiuSource('Sans range', ['https://x/Sans.wua'])
    expect((await downloadSource(db, id, cache, () => {}, noRange)).ok).toBe(true)
  })

  it('torrent : un .wua vWii est refusé sans télécharger le reste ; un .wua normal passe', { timeout: 30_000 }, async () => {
    const run = async (data: Buffer, dir: string): Promise<string[]> => {
      const f = makeFile(`${dir}/Jeu (USA).wua`, data)
      const t = await seed(f, "Jeu (USA).wua")
      return downloadTorrent({ input: t.magnet, workDir: join(cache, dir), title: 'Jeu (USA)', sizeBytes: null, consoleId: 'wiiu', signal: new AbortController().signal, onProgress: () => {} })
    }
    await expect(run(vwii(300_000), 'v')).rejects.toThrow(/vWii/)
    const ok = await run(makeWuaFiles([`${T}/code/app.xml`, `${T}/code/Game.rpx`, `${T}/meta/meta.xml`], 300_000), 'n')
    expect(existsSync(ok[0])).toBe(true)
  })
})

describe('Wii U vWii via downloadSource : dossier de travail supprimé', () => {
  it('un torrent .wua vWii : erreur claire et rien ne reste dans le cache', async () => {
    const T = '00050000101bff00_v0'
    const f = makeFile('g/Galaxy (EU).wua', makeWuaFiles([`${T}/code/frisbiiU.rpx`, `${T}/code/fw.img`, `${T}/meta/meta.xml`], 200_000))
    const t = await seed(f, 'Galaxy (EU).wua')
    db = new DatabaseSync(':memory:')
    migrate(db)
    db.prepare("INSERT INTO source_lists (name, url, added_at) VALUES ('L', 'https://x/l.json', 0)").run()
    db.prepare("INSERT INTO sources (list_id, console, title, uris) VALUES (1, 'wiiu', 'Galaxy (EU)', ?)").run(JSON.stringify([t.magnet]))
    const r = await downloadSource(db, 1, cache, () => {})
    expect(r).toEqual({ ok: false, error: VWII_REASON })
    expect(existsSync(join(cache, '1', 'torrent-0'))).toBe(false)
  })
})

describe('torrent → bibliothèque', () => {
  it('télécharge puis installe via le pipeline existant (hash du DAT)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv-tor-lib-'))
    try {
      const t = await seed(makeFile('lib/test.nes', Buffer.from('123456789')), 'test.nes') // crc cbf43926
      const id = addSource('Test', [t.magnet])
      db.prepare("INSERT INTO catalog_games (console, title, name, crc, size) VALUES ('nes', 'Test (Europe)', 'Test', 'cbf43926', 9)").run()
      db.prepare('UPDATE sources SET game_id = 1, matched = 1 WHERE id = 1').run()
      const paths: AppPaths = { dataDir: dir, roms: join(dir, 'roms'), emulators: join(dir, 'emulators'), bios: join(dir, 'bios'), saves: join(dir, 'saves'), cache: join(dir, 'cache'), dats: join(dir, 'dats'), logs: join(dir, 'logs') }
      const r = await downloadSource(db, id, join(dir, 'cache'), () => {})
      expect(r.ok).toBe(true)
      expect(await installDownload(db, id, r.file!, paths)).toEqual({ ok: true })
      expect(listLibrary(db)).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
