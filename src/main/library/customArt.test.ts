import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../db/migrations'
import { clearLibrary, removeEntry } from './libraryStore'
import { getOverrides, setOverride } from './overrides'
import { clearCustomImage, customArtDir, MAX_IMAGE_BYTES, pruneCustomArt, readCustomArt, removeEntryArt, resolveCustomArtPath, setCustomImage, sniffImage } from './customArt'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpg body')])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

let dir: string
let data: string
let db: DatabaseSync
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kcart-'))
  data = join(dir, 'data'); mkdirSync(data)
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const addEntry = (title = 'Zelda'): number =>
  Number(db.prepare("INSERT INTO library (console, title, path, size, match, added_at) VALUES ('snes', ?, ?, 1, 'hash', 0)").run(title, `p:${title}${Math.random()}`).lastInsertRowid)
const source = (name: string, content: Buffer): string => { const p = join(dir, name); writeFileSync(p, content); return p }
const filesOf = (id: number): string[] => (existsSync(join(customArtDir(data), String(id))) ? readdirSync(join(customArtDir(data), String(id))) : [])

describe('sniffImage', () => {
  it('reconnaît png, jpeg et webp par leurs premiers octets, rien d’autre', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(JPG)).toBe('jpg')
    expect(sniffImage(WEBP)).toBe('webp')
    for (const bad of [Buffer.from('GIF89a....'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('MZ\u0090 programme'), Buffer.alloc(0), Buffer.from('RIFF....WAVE')]) {
      expect(sniffImage(bad)).toBeNull()
    }
  })
})

describe('setCustomImage / clearCustomImage', () => {
  it('copie l’image dans le dossier des images personnelles et en fait la surcharge, sans toucher à l’original', async () => {
    const id = addEntry()
    const src = source('ma-jaquette.png', PNG)
    const r = await setCustomImage(db, data, id, 'cover', src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.path).toMatch(new RegExp(`^${id}/cover-\\d+\\.png$`))
    expect(getOverrides(db, id)).toEqual({ cover: r.path })
    expect(readFileSync(join(customArtDir(data), r.path))).toEqual(PNG)
    expect(readFileSync(src)).toEqual(PNG)
  })

  it('le format vient du contenu, pas de l’extension du fichier', async () => {
    const id = addEntry()
    const r = await setCustomImage(db, data, id, 'banner', source('photo.png', JPG))
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.path.endsWith('.jpg')).toBe(true)
  })

  it('remplacer une image supprime la précédente', async () => {
    const id = addEntry()
    const a = await setCustomImage(db, data, id, 'cover', source('a.png', PNG))
    await new Promise((r) => setTimeout(r, 5))
    const b = await setCustomImage(db, data, id, 'cover', source('b.webp', WEBP))
    expect(a.ok && b.ok).toBe(true)
    expect(filesOf(id)).toHaveLength(1)
    if (b.ok) expect(getOverrides(db, id)).toEqual({ cover: b.path })
  })

  it('refuse un fichier qui n’est pas une image, un fichier absent, trop gros, ou une entrée inconnue, sans rien écrire', async () => {
    const id = addEntry()
    expect(await setCustomImage(db, data, id, 'cover', source('faux.png', Buffer.from('ceci est du texte')))).toEqual({ ok: false, reason: 'notImage' })
    expect(await setCustomImage(db, data, id, 'cover', join(dir, 'absent.png'))).toEqual({ ok: false, reason: 'missing' })
    expect(await setCustomImage(db, data, id, 'cover', dir)).toEqual({ ok: false, reason: 'missing' })
    expect(await setCustomImage(db, data, id, 'cover', source('gros.png', Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])))).toEqual({ ok: false, reason: 'tooLarge' })
    expect(await setCustomImage(db, data, 9999, 'cover', source('ok.png', PNG))).toEqual({ ok: false, reason: 'entry' })
    expect(await setCustomImage(db, data, id, 'title' as never, source('ok2.png', PNG))).toEqual({ ok: false, reason: 'field' })
    expect(getOverrides(db, id)).toEqual({})
    expect(existsSync(customArtDir(data))).toBe(false)
  })

  it('applique la réduction fournie par l’appelant', async () => {
    const id = addEntry()
    const small = Buffer.concat([JPG, Buffer.from('petit')])
    const r = await setCustomImage(db, data, id, 'background', source('grande.png', PNG), { downscale: (_d, _t) => ({ data: small, type: 'jpg' }) })
    expect(r).toMatchObject({ ok: true })
    if (r.ok) { expect(r.path.endsWith('.jpg')).toBe(true); expect(readFileSync(join(customArtDir(data), r.path))).toEqual(small) }
  })

  it('clearCustomImage rétablit l’origine et supprime le fichier, sans toucher aux autres champs', async () => {
    const id = addEntry()
    setOverride(db, id, 'title', 'Link')
    await setCustomImage(db, data, id, 'icon', source('i.png', PNG))
    await clearCustomImage(db, data, id, 'icon')
    expect(getOverrides(db, id)).toEqual({ title: 'Link' })
    expect(filesOf(id)).toEqual([])
  })
})

describe('resolveCustomArtPath / readCustomArt', () => {
  it('ne sort jamais du dossier des images personnelles', async () => {
    const id = addEntry()
    const r = await setCustomImage(db, data, id, 'cover', source('c.png', PNG))
    if (!r.ok) throw new Error('image non enregistrée')
    writeFileSync(join(data, 'secret.png'), PNG)
    writeFileSync(join(dir, 'dehors.png'), PNG)
    expect(resolveCustomArtPath(data, r.path)).toBe(join(customArtDir(data), r.path))
    for (const bad of ['../secret.png', `${id}/../../secret.png`, '../../dehors.png', join(data, 'secret.png'), '/etc/passwd', 'C:\\Windows\\win.ini', `${id}\\cover.png`, '', '..', `${id}/../${id}/${r.path.split('/')[1]}`]) {
      expect(resolveCustomArtPath(data, bad), bad).toBeNull()
    }
  })

  it('sert le contenu avec son type, et rien pour un fichier qui n’est pas une image', async () => {
    const id = addEntry()
    const r = await setCustomImage(db, data, id, 'cover', source('c.png', JPG))
    if (!r.ok) throw new Error('image non enregistrée')
    expect(await readCustomArt(data, r.path)).toEqual({ data: JPG, type: 'image/jpeg' })
    writeFileSync(join(customArtDir(data), String(id), 'texte.png'), 'pas une image')
    expect(await readCustomArt(data, `${id}/texte.png`)).toBeNull()
    expect(await readCustomArt(data, `${id}/absent.png`)).toBeNull()
  })
})

describe('nettoyage', () => {
  it('removeEntryArt supprime les images et leurs surcharges d’une entrée, pas celles des autres', async () => {
    const a = addEntry('A'); const b = addEntry('B')
    await setCustomImage(db, data, a, 'cover', source('a.png', PNG))
    await setCustomImage(db, data, b, 'cover', source('b.png', PNG))
    setOverride(db, a, 'title', 'Gardé')
    await removeEntryArt(db, data, a)
    expect(filesOf(a)).toEqual([])
    expect(getOverrides(db, a)).toEqual({ title: 'Gardé' })
    expect(filesOf(b)).toHaveLength(1)
  })

  it('supprimer un jeu de la bibliothèque (entrée ou tout) supprime ses images', async () => {
    const a = addEntry('A'); const b = addEntry('B'); const c = addEntry('C')
    for (const id of [a, b, c]) await setCustomImage(db, data, id, 'cover', source(`${id}.png`, PNG))
    await removeEntry(db, a, 'entry', join(data, 'saves'), undefined, data)
    await removeEntry(db, b, 'all', join(data, 'saves'), undefined, data)
    expect(filesOf(a)).toEqual([])
    expect(filesOf(b)).toEqual([])
    expect(filesOf(c)).toHaveLength(1)
    expect(db.prepare('SELECT entry_id FROM library_overrides').all()).toEqual([{ entry_id: c }])
  })

  it('vider la bibliothèque supprime toutes les images personnelles', async () => {
    const a = addEntry('A')
    await setCustomImage(db, data, a, 'cover', source('a.png', PNG))
    clearLibrary(db, data)
    expect(existsSync(customArtDir(data))).toBe(false)
  })

  it('pruneCustomArt retire les dossiers sans entrée et les fichiers que plus aucune surcharge ne référence', async () => {
    const a = addEntry('A')
    const r = await setCustomImage(db, data, a, 'cover', source('a.png', PNG))
    if (!r.ok) throw new Error('image non enregistrée')
    writeFileSync(join(customArtDir(data), String(a), 'cover-1.png'), PNG) // reliquat d'un remplacement interrompu
    mkdirSync(join(customArtDir(data), '4242')); writeFileSync(join(customArtDir(data), '4242', 'cover-1.png'), PNG) // entrée disparue
    expect(await pruneCustomArt(db, data)).toBe(2)
    expect(filesOf(a)).toEqual([r.path.split('/')[1]])
    expect(existsSync(join(customArtDir(data), '4242'))).toBe(false)
    expect(await pruneCustomArt(db, data)).toBe(0)
  })

  it('pruneCustomArt ne fait rien (et ne plante pas) sans dossier d’images', async () => {
    expect(await pruneCustomArt(db, data)).toBe(0)
  })
})
