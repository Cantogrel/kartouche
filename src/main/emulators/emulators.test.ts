import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { EMULATORS, buildArgs, compareVersions, emulatorById, emulatorForConsole, explainFailure } from '@shared/emulators'
import { CONSOLES } from '@shared/consoles'
import { migrate } from '../db/migrations'
import { pickRelease, retroarchVersion } from './source'
import { findExe, flattenRoot, isFreshInstall } from './installer'
import { listEmulators, saveEmulator } from './emulatorStore'
import { relevantLogLines, resolveZippedRom, sessionMinutes } from './launcher'

/** Zip à plusieurs entrées (méthode déflate) ; un seul fichier suffit à simuler une ROM zippée. */
function makeZip(files: { name: string; data: Buffer }[]): Buffer {
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
  it('reconnaît une cause connue d’échec dans un journal, indépendamment de l’émulateur qui l’a écrite', () => {
    expect(explainFailure('W(CheckForRequiredSubQ): SBI file missing but required for SCES-02835')).toBe('play.quickExitSbi')
    expect(explainFailure('E BIOS: no bios file found for region')).toBe('play.quickExitBios')
    expect(explainFailure('firmware not found, aborting')).toBe('play.quickExitFirmware')
    // Constaté en vrai sur un .3ds : Azahar plante avec ce message précis quand le contenu est détecté comme chiffré (le plus souvent
    // un dump mal étiqueté « decrypted » qui ne l'est pas vraiment — Azahar embarque ses propres clés depuis fin 2024, ce n'est
    // presque jamais un problème de clés manquantes de notre côté, voir azahar-emu/azahar#1383).
    expect(explainFailure('Core <Critical> core\\core.cpp:Core::System::Load:353: Failed to determine system mode (Error 8)!')).toBe('play.quickExit3dsCrypto')
    expect(explainFailure('I/Core: démarrage normal')).toBeUndefined()
    expect(explainFailure(undefined)).toBeUndefined()
  })
  it('ne garde que les lignes d’avertissement/erreur d’un journal, sinon les dernières lignes', () => {
    const log = ['I/Core: démarrage', 'I/BIOS: recherche…', 'W(CheckForRequiredSubQ): SBI file missing but required for SCES-02835', 'I/VideoThread: arrêt'].join('\n')
    expect(relevantLogLines(log)).toBe('W(CheckForRequiredSubQ): SBI file missing but required for SCES-02835')
    const noisy = Array.from({ length: 30 }, (_, i) => `I/Core: ligne ${i}`).join('\n')
    expect(relevantLogLines(noisy, 5)).toBe(Array.from({ length: 5 }, (_, i) => `I/Core: ligne ${25 + i}`).join('\n'))
  })
  // Certains .zip (constaté sur des .gbc No-Intro avec le drapeau EFS/UTF-8) ne sont pas décompressés par le lecteur
  // d'archive intégré à RetroArch, qui tente alors d'ouvrir le .zip lui-même comme ROM et se ferme aussitôt ; d'autres
  // émulateurs (Azahar…) ne savent tout simplement pas lire un .zip. On extrait donc toujours nous-mêmes.
  it('extrait elle-même le fichier d’un zip à une entrée, quel que soit l’émulateur visé', async () => {
    const data = Buffer.from('cartouche gbc')
    const zip = join(dir, 'Jeu.zip')
    writeFileSync(zip, makeZip([{ name: 'Jeu.gbc', data }]))
    const out = await resolveZippedRom(zip, dir)
    expect(out).toBe(join(dir, 'extracted-rom', 'Jeu.gbc'))
    expect(readFileSync(out!)).toEqual(data)
  })
  it('laisse passer un chemin qui n’est pas un zip', async () => {
    expect(await resolveZippedRom(join(dir, 'a.gba'), dir)).toBe(join(dir, 'a.gba'))
  })
  it('renvoie null pour un zip illisible ou qui contient plus d’un fichier', async () => {
    const bad = join(dir, 'bad.zip'); writeFileSync(bad, 'pas un zip')
    expect(await resolveZippedRom(bad, dir)).toBeNull()
    const multi = join(dir, 'multi.zip')
    writeFileSync(multi, makeZip([{ name: 'a.gb', data: Buffer.from('a') }, { name: 'b.gb', data: Buffer.from('b') }]))
    expect(await resolveZippedRom(multi, dir)).toBeNull()
  })
})
