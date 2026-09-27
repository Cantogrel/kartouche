import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMULATORS, buildArgs, compareVersions, emulatorById, emulatorForConsole } from '@shared/emulators'
import { CONSOLES } from '@shared/consoles'
import { migrate } from '../db/migrations'
import { pickRelease, retroarchVersion } from './source'
import { findExe, flattenRoot, isFreshInstall } from './installer'
import { listEmulators, saveEmulator } from './emulatorStore'
import { sessionMinutes } from './launcher'

describe('émulateurs : définitions', () => {
  it('chaque console du catalogue a un émulateur, et un seul', () => {
    for (const c of CONSOLES) expect(EMULATORS.filter((e) => e.consoles.includes(c.id)), c.id).toHaveLength(1)
  })
  it('les arguments remplacent {rom} et {core}', () => {
    expect(buildArgs(emulatorById('retroarch')!, 'C:/r/a.gba', 'gba')).toEqual(['-f', '-L', 'cores/mgba_libretro.dll', 'C:/r/a.gba'])
    expect(buildArgs(emulatorById('dolphin')!, 'x.iso', 'wii')).toEqual(['-b', '-e', 'x.iso'])
  })
  it('refuse une console que l’émulateur ne gère pas', () => {
    expect(buildArgs(emulatorById('dolphin')!, 'x', 'ps1')).toBeNull()
    expect(emulatorForConsole('switch')?.id).toBe('eden')
  })
})

describe('émulateurs : installation fraîche', () => {
  it('jamais installé (aucune ligne) : fraîche', () => {
    expect(isFreshInstall(undefined)).toBe(true)
  })
  it('exécutable enregistré mais absent (dossier supprimé hors de RomVault) : fraîche quand même — rien à préserver', () => {
    expect(isFreshInstall({ exe: 'E:/dossier-qui-n-existe-pas-9273/x.exe' })).toBe(true)
  })
  it('exécutable enregistré et présent : pas fraîche, les réglages de l’utilisateur sont gardés', () => {
    expect(isFreshInstall({ exe: __filename })).toBe(false)
  })
})

describe('émulateurs : sources', () => {
  const rel = (tag: string, names: string[], extra = {}) => ({ tag_name: tag, assets: names.map((n) => ({ name: n, browser_download_url: `https://x/${tag}/${n}` })), ...extra })
  it('prend la première version qui a le bon fichier et ignore brouillons et préversions', () => {
    const r = pickRelease([rel('v3', ['a.zip'], { prerelease: true }), rel('v2', ['b.txt']), rel('v1', ['pcsx2-v1-windows-x64-Qt.7z'])], '^pcsx2-.*Qt\.7z$', false)
    expect(r?.version).toBe('v1')
    expect(pickRelease([rel('v3', ['pcsx2-v3-windows-x64-Qt.7z'], { prerelease: true })], '^pcsx2-.*Qt\.7z$', true)?.version).toBe('v3')
    expect(pickRelease([rel('v1', ['x'])], 'y', true)).toBeNull()
    // Étiquette glissante : la date de publication sert de version.
    expect(pickRelease([rel('latest', ['d.zip'], { published_at: '2026-09-12T12:20:15Z' })], 'd', false)?.version).toBe('2026-09-12')
  })
  it('choisit la plus haute version stable de RetroArch (tri numérique)', () => {
    expect(retroarchVersion('<a href="/stable/1.9.9/"><a href="/stable/1.22.2/"><a href="/stable/1.10.0/">')).toBe('1.22.2')
  })
  it('compare les versions numériquement', () => {
    expect(compareVersions('1.10.2', '1.9')).toBe(1)
    expect(compareVersions('v2.6', '2.6.0')).toBe(0)
    expect(compareVersions('2126.1.1', '2126.1.2')).toBe(-1)
  })
})

describe('émulateurs : installation', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-emu-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('descend dans le dossier racine unique et retrouve l’exécutable sans tenir compte de la casse', async () => {
    mkdirSync(join(dir, 'Dolphin-x64', 'Sys'), { recursive: true })
    writeFileSync(join(dir, 'Dolphin-x64', 'dolphin.EXE'), '')
    const root = await flattenRoot(dir)
    expect(root).toBe(join(dir, 'Dolphin-x64'))
    expect(await findExe(dir, ['Dolphin.exe'])).toBe(join(dir, 'Dolphin-x64', 'dolphin.EXE'))
    expect(await findExe(dir, ['nope.exe'])).toBeNull()
  })
  it('enregistre et liste les émulateurs, signale un exécutable disparu', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)
    expect(listEmulators(db).every((e) => !e.installed)).toBe(true)
    const exe = join(dir, 'melonDS.exe')
    saveEmulator(db, { id: 'melonds', version: '1.1', dir, exe, custom: false })
    expect(listEmulators(db).find((e) => e.id === 'melonds')).toMatchObject({ installed: true, version: '1.1', missing: true })
    writeFileSync(exe, '')
    expect(listEmulators(db).find((e) => e.id === 'melonds')?.missing).toBe(false)
  })
  it('arrondit le temps de jeu à la minute (moins de 30 s = 0)', () => {
    expect(sessionMinutes(29000)).toBe(0)
    expect(sessionMinutes(31000)).toBe(1)
    expect(sessionMinutes(90 * 60000)).toBe(90)
  })
})
