import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyUserData } from './legacy'

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
