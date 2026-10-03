import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { patchIni } from '../configure'
import { readWiiUTitleId } from '../../saves/identify'
import { makeAppXml, makeCosXml, makeFullPkg, makeInstallableCia, makeSfo, makeVitaArchive } from '../../library/content/emu.testutil'
import { listPkgFiles } from '../../library/content/pkgFiles'
import { probeVitaArchive } from '../../library/content/vita'
import { rpcs3Installer } from './rpcs3'
import { makeMetaXml } from '../../library/content/content.testutil'
import { azaharTitleDir, azaharInstaller } from './azahar'
import { cemuGamePaths, registerCemuGamePath } from './cemu'
import { edenConfigFile, registerExternalDir } from './eden'
import { makeVita3kInstaller, vita3kPrefPath } from './vita3k'
import type { InstallEnv } from './types'
import { guard, launchUntil } from './real.testutil'

// TESTS RÉELS : ils lancent le VRAI émulateur installé dans data/emulators/ avec de VRAIS jeux, sur la machine de développement. Désactivés par défaut (ils ouvrent des fenêtres, modifient
// puis RESTAURENT la configuration de l'émulateur) : `ROMVAULT_REAL_EMU=1 npx vitest run src/main/emulators/content/real-emulators.test.ts`.
// Ce qu'ils valident est écrit dans chaque test — et seulement cela. Une plateforme absente de ce fichier (3DS, PS3) n'a PAS été validée en réel : aucun .cia/.pkg de mise à jour disponible.
// Pour la valider, voir « Valider une plateforme dès qu'un fichier réel existe » dans docs/content-support.md.

const REAL = process.env['ROMVAULT_REAL_EMU'] === '1'
const D = String.raw`E:\dev\RomVault\data`
const run = REAL ? describe : describe.skip

run('Cemu (réel) — découverte d’une mise à jour par les chemins de jeux', () => {
  const cemuDir = join(D, 'emulators', 'cemu')
  const wux = join(D, 'roms', 'wiiu', 'Legend of Zelda, The - The Wind Waker HD (Europe) (En,Fr,De,Es,It).wux')
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rv-real-cemu-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('Cemu liste dans « Update: » le titre rangé sous un chemin de jeux déclaré par RomVault (et « Not present » sans lui)', async () => {
    const baseId = await readWiiUTitleId(wux, cemuDir)
    expect(baseId).toMatch(/^00050000[0-9A-F]{8}$/)
    const updId = `0005000E${baseId!.slice(8)}`
    // Titre « mise à jour » au format extrait (code/ content/ meta/), construit à la main : un VRAI Cemu doit le découvrir et le monter ; ce n'est PAS un vrai dump (aucune mise à jour réelle disponible).
    const contentDir = join(tmp, 'wiiu', '.content')
    const upd = join(contentDir, baseId!, 'maj-synthetique')
    for (const [rel, data] of [['meta/meta.xml', makeMetaXml(updId, 99)], ['code/app.xml', makeAppXml(updId, 99)], ['code/cos.xml', makeCosXml()]] as const) { mkdirSync(dirname(join(upd, rel)), { recursive: true }); writeFileSync(join(upd, rel), data) }
    mkdirSync(join(upd, 'content'), { recursive: true })
    const settings = join(cemuDir, 'settings.xml')
    const g = guard([settings, join(cemuDir, 'log.txt')])
    try {
      // Témoin : sans le chemin de jeux.
      const control = await launchUntil(join(cemuDir, 'Cemu.exe'), ['-g', wux], cemuDir, join(cemuDir, 'log.txt'), /(Update: |DLC: )/, 120_000)
      expect(control).toMatch(/Update: Not present/)
      // Avec le chemin déclaré par le code de RomVault (registerCemuGamePath, comme l'installateur le fait).
      const { text } = registerCemuGamePath(readFileSync(settings, 'utf8'), contentDir)
      writeFileSync(settings, text)
      expect(cemuGamePaths(readFileSync(settings, 'utf8'))).toContain(contentDir.replace(/\\/g, '/'))
      const withContent = await launchUntil(join(cemuDir, 'Cemu.exe'), ['-g', wux], cemuDir, join(cemuDir, 'log.txt'), /(Update: |DLC: )/, 120_000)
      expect(withContent).toContain('Update: ')
      expect(withContent).not.toMatch(/Update: Not present/)
      expect(withContent.replace(/\\/g, '/')).toContain('maj-synthetique')
    } finally { g.restore() }
  }, 600_000)
})

run('Eden (réel) — mise à jour lue depuis le dossier de contenu externe', () => {
  const edenDir = join(D, 'emulators', 'eden')
  const SRC = String.raw`C:\Users\mathc\Downloads\Animal Crossing New Horizons [NSP]`
  const base = join(SRC, 'Animal Crossing New Horizons [01006F8002326000][v0].nsp')
  const log = join(edenDir, 'user', 'log', 'eden_log.txt')
  it('avec l’entrée `external_content_dirs` écrite par RomVault : « Update … applied successfully » ; sans elle : aucune mise à jour', async () => {
    if (!existsSync(base)) return
    const cfg = edenConfigFile(edenDir)
    const g = guard([cfg, log])
    try {
      const debug = (t: string): string => patchIni(t, { Miscellaneous: { 'log_filter\\default': 'false', log_filter: '"*:Debug"' } }, '=')
      writeFileSync(cfg, debug(readFileSync(cfg, 'utf8')))
      const control = await launchUntil(join(edenDir, 'eden.exe'), ['-g', base], edenDir, log, /BootGame: Booting game/, 120_000)
      expect(control).not.toMatch(/Update \(v[\d.]+\) applied successfully/)
      writeFileSync(cfg, debug(registerExternalDir(readFileSync(cfg, 'utf8'), SRC).text))
      const withContent = await launchUntil(join(edenDir, 'eden.exe'), ['-g', base], edenDir, log, /Update \(v[\d.]+\) applied successfully/, 120_000)
      expect(withContent.split(/\r?\n/).filter((l) => /External|Update \(|configured/.test(l)).join(' | ')).toMatch(/Initializing ExternalContentProvider with [1-9]d* configured directories/)
      expect(withContent).toMatch(/Update \(v[\d.]+\) applied successfully/)
    } finally { g.restore() }
  }, 600_000)
})

run('Vita3K (réel) — DLC et mise à jour installés par le CLI de Vita3K, suivis, puis désinstallés', () => {
  const vitaDir = join(D, 'emulators', 'vita3k')
  const T = 'PCSE00097'
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rv-real-vita-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))
  const sha = (p: string): string => createHash('sha1').update(readFileSync(p)).digest('hex')
  const env = (): InstallEnv => ({ romsDir: join(tmp, 'roms'), emulator: { dir: vitaDir, exe: join(vitaDir, 'Vita3K.exe') }, isRunning: async () => false })

  it('identification d’un VRAI jeu Vita (.zip du jeu installé) : catégorie `gd`, TITLE_ID lu dans son PARAM.SFO', async () => {
    const zip = join(D, 'roms', 'vita', 'Call of Duty Black Ops - Declassified (PCSE00097) (NTSC).zip')
    if (!existsSync(zip)) return
    expect(await probeVitaArchive(zip)).toMatchObject({ console: 'vita', kind: 'base', baseKey: T })
  })

  it('DLC (archive avec PARAM.SFO, contenu synthétique) : Vita3K l’installe dans ux0/addcont, RomVault suit ce qu’il a créé et le retire', async () => {
    const pref = await vita3kPrefPath(vitaDir)
    if (!existsSync(join(pref, 'ux0', 'app', T))) return // jeu non installé dans Vita3K : rien à tester
    const cid = `EP0000-${T}_00-RVTESTDLC0000001`
    const arc = join(tmp, 'dlc-synthetique.zip')
    writeFileSync(arc, makeVitaArchive({ category: 'ac', titleId: T, contentId: cid, files: { 'data/romvault-test.bin': 'contenu de test RomVault' } }))
    const inst = makeVita3kInstaller()
    const out = await inst.install(env(), { id: 9001, kind: 'dlc', path: arc, titleId: cid, version: null, needs: null }, { id: 1, console: 'vita', title: 'CoD', path: 'x', baseKey: T }, 'launch')
    expect(out).toMatchObject({ state: 'installed' })
    const dlcDir = join(pref, 'ux0', 'addcont', T, cid.slice(20))
    expect(existsSync(join(dlcDir, 'data', 'romvault-test.bin'))).toBe(true)
    expect(out.emuFiles).toContain(dlcDir)
    const un = await inst.uninstall!(env(), [{ id: 9001, kind: 'dlc', path: arc, titleId: cid, version: null, needs: null, emuFiles: out.emuFiles }], { id: 1, console: 'vita', title: 'CoD', path: 'x', baseKey: T })
    expect(un).toMatchObject({ ok: true })
    expect(existsSync(dlcDir)).toBe(false)
    expect(existsSync(join(pref, 'ux0', 'app', T, 'eboot.bin'))).toBe(true) // le jeu n'a pas été touché
  }, 300_000)

  it('mise à jour (archive gp synthétique) : fusionnée dans le jeu par Vita3K ; l’original de chaque fichier écrasé est sauvegardé puis remis à la désinstallation (hash identique)', async () => {
    const pref = await vita3kPrefPath(vitaDir)
    const appDir = join(pref, 'ux0', 'app', T)
    if (!existsSync(appDir) || process.env['ROMVAULT_REAL_EMU_VITA_PATCH'] !== '1') return // modifie le dossier du jeu (restauré) : opt-in explicite en plus
    const before = new Map<string, string>()
    const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else before.set(p, sha(p)) } }
    walk(appDir)
    const sfoPath = join(appDir, 'sce_sys', 'param.sfo')
    const safety = join(tmp, 'param.sfo.safety')
    copyFileSync(sfoPath, safety) // filet de sécurité INDÉPENDANT du mécanisme testé
    const arc = join(tmp, 'maj-synthetique.vpk')
    writeFileSync(arc, makeVitaArchive({ category: 'gp', titleId: T, version: '99.00', files: { 'romvault-test-patch.bin': 'patch de test' } }))
    const inst = makeVita3kInstaller()
    const out = await inst.install(env(), { id: 9002, kind: 'update', path: arc, titleId: `${T}:99.00`, version: '99.00', needs: null }, { id: 1, console: 'vita', title: 'CoD', path: 'x', baseKey: T }, 'launch')
    try {
      expect(out).toMatchObject({ state: 'installed' })
      expect(existsSync(join(appDir, 'romvault-test-patch.bin'))).toBe(true)
      expect(Object.keys(out.emuBackups ?? {}).some((k) => k.toLowerCase().endsWith('param.sfo'))).toBe(true) // le PARAM.SFO du jeu a été écrasé par celui de la mise à jour
      const un = await inst.uninstall!(env(), [{ id: 9002, kind: 'update', path: arc, titleId: null, version: '99.00', needs: null, emuFiles: out.emuFiles, emuBackups: out.emuBackups }], { id: 1, console: 'vita', title: 'CoD', path: 'x', baseKey: T })
      expect(un).toMatchObject({ ok: true })
    } finally {
      if (sha(sfoPath) !== sha(safety)) copyFileSync(safety, sfoPath)
    }
    const after = new Map<string, string>()
    const walk2 = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk2(p); else after.set(p, sha(p)) } }
    walk2(appDir)
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort()) // dossier du jeu strictement identique à l'origine
  }, 300_000)
})

run('Azahar (réel) — un .cia de mise à jour installé par `azahar -i`, suivi, puis désinstallé', () => {
  const azDir = join(D, 'emulators', 'azahar')
  const TID = '0004000E00FFFE00' // titre factice : aucun jeu réel n'a cet identifiant
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rv-real-az-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('Azahar installe le .cia (SD virtuelle + ticket), RomVault enregistre exactement ce qui a été créé, la désinstallation retire cela et rien d’autre', async () => {
    const cia = join(tmp, 'maj-synthetique.cia')
    writeFileSync(cia, makeInstallableCia(TID, { version: 1 << 10 }))
    const env: InstallEnv = { romsDir: join(tmp, 'roms'), emulator: { dir: azDir, exe: join(azDir, 'azahar.exe') }, isRunning: async () => false }
    const title = azaharTitleDir(azDir, TID)!
    expect(existsSync(title)).toBe(false) // pas là avant
    const out = await azaharInstaller.install(env, { id: 9003, kind: 'update', path: cia, titleId: TID, version: null, needs: null }, { id: 1, console: 'n3ds', title: 't', path: 'x', baseKey: '0004000000FFFE00' }, 'launch')
    try {
      expect(out).toMatchObject({ state: 'installed' })
      expect(existsSync(join(title, 'content'))).toBe(true)
      expect(out.emuFiles!.some((p) => p.toLowerCase().endsWith('.tik'))).toBe(true)
      expect(out.emuFiles).toContain(join(title, 'content'))
    } finally {
      const un = await azaharInstaller.uninstall!(env, [{ id: 9003, kind: 'update', path: cia, titleId: TID, version: null, needs: null, emuFiles: out.emuFiles ?? [] }], { id: 1, console: 'n3ds', title: 't', path: 'x', baseKey: '' })
      expect(un).toMatchObject({ ok: true })
    }
    expect(existsSync(title)).toBe(false)
    const tickets = join(azDir, 'user', 'nand', 'dbs', 'ticket.db')
    expect(existsSync(tickets) ? readdirSync(tickets).filter((n) => n.startsWith(TID)) : []).toEqual([])
  }, 300_000)
})

run('RPCS3 (réel) — un .pkg installé par `rpcs3 --headless --installpkg`, suivi, puis désinstallé', () => {
  const rpDir = join(D, 'emulators', 'rpcs3')
  const SERIAL = 'BLES99999' // numéro de série factice
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'rv-real-rpcs3-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('RPCS3 accepte le paquet (format lu par listPkgFiles), écrit exactement les fichiers annoncés ; RomVault enregistre ce qui est créé et le retire', async () => {
    const entries = [
      { name: 'PARAM.SFO', data: makeSfo({ TITLE_ID: SERIAL, CATEGORY: 'GD', TITLE: 'RomVault test', APP_VER: '01.01', PARAMS: 'x' }) },
      { name: 'USRDIR', folder: true },
      { name: 'USRDIR/EBOOT.BIN', data: Buffer.from('eboot de test RomVault') },
      { name: 'USRDIR/data.dat', data: Buffer.from('donnees') }
    ]
    const pkg = join(tmp, 'patch-synthetique.pkg')
    writeFileSync(pkg, makeFullPkg({ serial: SERIAL, flags: 0x10, entries }))
    const listing = (await listPkgFiles(pkg))!
    expect(listing.entries.filter((e) => !e.folder).map((e) => e.name).sort()).toEqual(['PARAM.SFO', 'USRDIR/EBOOT.BIN', 'USRDIR/data.dat'])
    const gameDir = join(rpDir, 'dev_hdd0', 'game', SERIAL)
    expect(existsSync(gameDir)).toBe(false)
    const env: InstallEnv = { romsDir: join(tmp, 'roms'), emulator: { dir: rpDir, exe: join(rpDir, 'rpcs3.exe') }, isRunning: async () => false }
    const out = await rpcs3Installer.install(env, { id: 9004, kind: 'update', path: pkg, titleId: null, version: null, needs: null }, { id: 1, console: 'ps3', title: 't', path: 'x', baseKey: SERIAL }, 'launch')
    try {
      expect(out).toMatchObject({ state: 'installed' })
      expect(existsSync(join(gameDir, 'USRDIR', 'EBOOT.BIN'))).toBe(true)
      expect(readFileSync(join(gameDir, 'USRDIR', 'data.dat'), 'utf8')).toBe('donnees')
      expect(out.emuFiles).toEqual([gameDir])
    } finally {
      const un = await rpcs3Installer.uninstall!(env, [{ id: 9004, kind: 'update', path: pkg, titleId: null, version: null, needs: null, emuFiles: out.emuFiles ?? [gameDir] }], { id: 1, console: 'ps3', title: 't', path: 'x', baseKey: SERIAL })
      expect(un).toMatchObject({ ok: true })
    }
    expect(existsSync(gameDir)).toBe(false)
  }, 600_000)
})
