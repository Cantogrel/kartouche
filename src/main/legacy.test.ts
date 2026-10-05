import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyUserData, removeLegacyUpdaterCache, retireLegacyUserData } from './legacy'

let root: string
let legacy: string
let current: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kartouche-legacy-'))
  legacy = join(root, 'RomVault')
  current = join(root, 'Kartouche')
  mkdirSync(legacy, { recursive: true })
  mkdirSync(current, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('migrateLegacyUserData', () => {
  it('reprend bootstrap.json et le stockage local de l’ancien dossier, sans le toucher', () => {
    writeFileSync(join(legacy, 'bootstrap.json'), '{"dataDir":"D:\\\\Jeux"}')
    mkdirSync(join(legacy, 'Local Storage', 'leveldb'), { recursive: true })
    writeFileSync(join(legacy, 'Local Storage', 'leveldb', '000003.log'), 'x')
    expect(migrateLegacyUserData(current, [legacy])).toEqual(['bootstrap.json', 'Local Storage'])
    expect(readFileSync(join(current, 'bootstrap.json'), 'utf8')).toBe('{"dataDir":"D:\\\\Jeux"}')
    expect(readFileSync(join(current, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('x')
    expect(existsSync(join(legacy, 'bootstrap.json'))).toBe(true)
  })

  it('n’écrase jamais un élément déjà présent côté Kartouche', () => {
    writeFileSync(join(legacy, 'bootstrap.json'), '{"dataDir":"ancien"}')
    writeFileSync(join(current, 'bootstrap.json'), '{"dataDir":"nouveau"}')
    expect(migrateLegacyUserData(current, [legacy])).toEqual([])
    expect(readFileSync(join(current, 'bootstrap.json'), 'utf8')).toBe('{"dataDir":"nouveau"}')
  })

  it('ne fait rien sans ancien dossier, ou si l’ancien dossier est le dossier courant (casse différente)', () => {
    expect(migrateLegacyUserData(current, [join(root, 'absent')])).toEqual([])
    writeFileSync(join(current, 'bootstrap.json'), '{}')
    expect(migrateLegacyUserData(current, [current.toUpperCase()])).toEqual([])
  })

  it('repart de zéro pour un élément absent sans erreur, et reste idempotent', () => {
    writeFileSync(join(legacy, 'bootstrap.json'), '{"dataDir":"X"}')
    expect(migrateLegacyUserData(current, [legacy])).toEqual(['bootstrap.json'])
    expect(migrateLegacyUserData(current, [legacy])).toEqual([])
  })
})

describe('retireLegacyUserData', () => {
  it('retire les fichiers Chromium et les éléments repris, puis le dossier vide', () => {
    writeFileSync(join(legacy, 'bootstrap.json'), '{"dataDir":"D:\Jeux"}')
    mkdirSync(join(legacy, 'Local Storage'), { recursive: true })
    for (const d of ['Cache', 'Code Cache', 'GPUCache']) { mkdirSync(join(legacy, d)); writeFileSync(join(legacy, d, 'f'), 'x') }
    writeFileSync(join(legacy, 'Preferences'), '{}')
    migrateLegacyUserData(current, [legacy])
    const removed = retireLegacyUserData(current, legacy)
    expect(removed).toEqual(expect.arrayContaining(['bootstrap.json', 'Local Storage', 'Cache', 'Code Cache', 'GPUCache', 'Preferences']))
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(join(current, 'bootstrap.json'), 'utf8')).toBe('{"dataDir":"D:\Jeux"}')
  })

  it('ne supprime jamais un élément inconnu (ex. un ancien dossier data) et garde le dossier', () => {
    mkdirSync(join(legacy, 'data', 'roms'), { recursive: true })
    writeFileSync(join(legacy, 'data', 'romvault.db'), 'ma bibliothèque')
    mkdirSync(join(legacy, 'Cache'))
    expect(retireLegacyUserData(current, legacy)).toEqual(['Cache'])
    expect(readFileSync(join(legacy, 'data', 'romvault.db'), 'utf8')).toBe('ma bibliothèque')
  })

  it('garde bootstrap.json et Local Storage tant que leur copie n’existe pas côté Kartouche', () => {
    writeFileSync(join(legacy, 'bootstrap.json'), '{"dataDir":"X"}')
    mkdirSync(join(legacy, 'Local Storage'))
    expect(retireLegacyUserData(current, legacy)).toEqual([])
    expect(existsSync(join(legacy, 'bootstrap.json'))).toBe(true)
    expect(existsSync(join(legacy, 'Local Storage'))).toBe(true)
  })

  it('ne touche à rien si l’ancien dossier est le dossier courant ou n’existe pas', () => {
    mkdirSync(join(current, 'Cache'))
    expect(retireLegacyUserData(current, current.toUpperCase())).toEqual([])
    expect(existsSync(join(current, 'Cache'))).toBe(true)
    expect(retireLegacyUserData(current, join(root, 'absent'))).toEqual([])
  })
})

describe('removeLegacyUpdaterCache', () => {
  it('supprime romvault-updater (installateur téléchargé) et rien d’autre', () => {
    mkdirSync(join(root, 'romvault-updater', 'pending'), { recursive: true })
    writeFileSync(join(root, 'romvault-updater', 'pending', 'installer.exe'), 'x')
    mkdirSync(join(root, 'kartouche-updater'))
    expect(removeLegacyUpdaterCache(root)).toBe(true)
    expect(existsSync(join(root, 'romvault-updater'))).toBe(false)
    expect(existsSync(join(root, 'kartouche-updater'))).toBe(true)
    expect(removeLegacyUpdaterCache(root)).toBe(false)
    expect(removeLegacyUpdaterCache(undefined)).toBe(false)
  })
})
