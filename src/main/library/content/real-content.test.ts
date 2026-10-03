import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { azaharInstaller } from '../../emulators/content/azahar'
import { cemuGamePaths, cemuInstaller, cemuSettingsFile } from '../../emulators/content/cemu'
import { rpcs3Installer } from '../../emulators/content/rpcs3'
import { snapshotTrees } from '../../emulators/content/snapshot'
import type { ContentInstaller, InstallEnv } from '../../emulators/content/types'
import { vita3kInstaller, vita3kPrefPath } from '../../emulators/content/vita3k'
import { azaharTitleDir } from '../../emulators/content/azahar'
import type { ContentInfo } from './types'
import { probeFile, probeWiiUFolder } from './probe'
import { placeContent } from './store'
import { guard, launchUntil } from '../../emulators/content/real.testutil'

// VRAIS FICHIERS DE MISE À JOUR / DLC. Ce fichier est l'outil à utiliser dès qu'on dispose d'un vrai contenu : déposer les fichiers dans un dossier (variable d'environnement
// `ROMVAULT_REAL_CONTENT_DIR`, par défaut `E:\dev\RomVault\test-content`), un sous-dossier par plateforme :
//
//   3ds/    *.cia  (mise à jour 0004000E… ou DLC 0004008C…)          →  Azahar
//   ps3/    *.pkg  (patch ou DLC)                                      →  RPCS3
//   vita/   *.vpk / *.zip (archive avec sce_sys/param.sfo) ou *.pkg (+ *.pkg.zrif fourni par l'utilisateur)  →  Vita3K
//   wiiu/   dossiers NUS (title.tmd + title.tik + *.app) ou extraits (code/content/meta), ou *.wua  →  Cemu
//
// Puis : `npm run test:real` (variable ROMVAULT_REAL_EMU=1 : lance le VRAI émulateur, modifie puis restaure son espace). Sans fichier pour une plateforme, son test est SAUTÉ avec un message :
// cette plateforme n'est alors PAS validée avec un vrai contenu (voir docs/content-support.md). Sans ROMVAULT_REAL_EMU, seule l'IDENTIFICATION est vérifiée.
// L'émulateur doit être installé dans RomVault et, pour Vita3K, le jeu parent déjà installé dans Vita3K (il l'est au premier lancement du jeu depuis RomVault).

const ROOT = process.env['ROMVAULT_REAL_CONTENT_DIR'] ?? String.raw`E:\dev\RomVault\test-content`
const WITH_EMU = process.env['ROMVAULT_REAL_EMU'] === '1'
const EMU = String.raw`E:\dev\RomVault\data\emulators`

const list = (sub: string, ext: RegExp): string[] => { const d = join(ROOT, sub); return existsSync(d) ? readdirSync(d).filter((n) => ext.test(n)).map((n) => join(d, n)) : [] }
const dirs = (sub: string): string[] => { const d = join(ROOT, sub); return existsSync(d) ? readdirSync(d).map((n) => join(d, n)).filter((p) => statSync(p).isDirectory()) : [] }
const sha = (p: string): string => createHash('sha1').update(readFileSync(p)).digest('hex')

/** Photographie « contenu » (taille + empreinte) d'un ensemble de dossiers : comparable avant/après sans dépendre des dates (une restauration en change). */
async function fingerprint(roots: string[]): Promise<string[]> {
  const snap = await snapshotTrees(roots)
  return [...snap.files.values()].map((f) => `${f.path}|${statSync(f.path).size}|${statSync(f.path).size < 64 * 1024 * 1024 ? sha(f.path) : ''}`).sort()
}

function identified(info: ContentInfo | null): asserts info is ContentInfo {
  expect(info, 'fichier non reconnu comme contenu').not.toBeNull()
  expect(['update', 'dlc'], `identifié « ${info?.kind} » (${info?.reason ?? ''})`).toContain(info!.kind)
  expect(info!.baseKey, 'jeu parent non déterminé').toBeTruthy()
}

async function cycle(installer: ContentInstaller, env: InstallEnv, info: ContentInfo, path: string, roots: string[], extra: (out: Awaited<ReturnType<ContentInstaller['install']>>) => void = () => undefined): Promise<void> {
  const before = await fingerprint(roots)
  const item = { id: 9100, kind: info.kind as 'update' | 'dlc', path, titleId: info.titleId, version: info.version, needs: info.needs ?? null }
  const game = { id: 1, console: info.console, title: 'réel', path: 'x', baseKey: info.baseKey }
  const out = await installer.install(env, item, game, 'launch')
  try {
    expect(out, `installation : ${JSON.stringify(out)}`).toMatchObject({ state: 'installed' })
    expect(out.emuFiles, 'aucun suivi des fichiers').toBeDefined()
    extra(out)
  } finally {
    if (installer.uninstall) {
      const un = await installer.uninstall(env, [{ ...item, emuFiles: out.emuFiles ?? [], emuBackups: out.emuBackups ?? null, installedAt: Date.now() }], game)
      expect(un).toMatchObject({ ok: true })
    }
  }
  expect(await fingerprint(roots), "l'espace de l'émulateur n'est pas revenu à l'état d'avant").toEqual(before)
}

const skipMsg = (p: string): string => `aucun fichier réel dans ${join(ROOT, p)} — plateforme NON validée avec un vrai contenu`

describe('contenu réel — 3DS / Azahar', () => {
  const files = list('3ds', /\.cia$/i)
  it.skipIf(files.length === 0)('chaque .cia : identifié puis (ROMVAULT_REAL_EMU=1) installé par `azahar -i`, suivi exactement, désinstallé', async () => {
    for (const f of files) {
      const info = await probeFile(f)
      identified(info)
      if (!WITH_EMU) continue
      const az = join(EMU, 'azahar')
      const env: InstallEnv = { romsDir: mkdtempSync(join(tmpdir(), 'rv-real-')), emulator: { dir: az, exe: join(az, 'azahar.exe') }, isRunning: async () => false }
      await cycle(azaharInstaller, env, info, f, [azaharTitleDir(az, info.titleId)!, join(az, 'user', 'nand', 'dbs', 'ticket.db')])
      rmSync(env.romsDir, { recursive: true, force: true })
    }
  }, 900_000)
  if (files.length === 0) it('3ds : ' + skipMsg('3ds'), () => undefined)
})

describe('contenu réel — PS3 / RPCS3', () => {
  const files = list('ps3', /\.pkg$/i)
  it.skipIf(files.length === 0)('chaque .pkg : identifié puis installé par `rpcs3 --headless --installpkg`, suivi exactement, désinstallé', async () => {
    for (const f of files) {
      const info = await probeFile(f)
      identified(info)
      if (!WITH_EMU) continue
      const rp = join(EMU, 'rpcs3')
      const env: InstallEnv = { romsDir: mkdtempSync(join(tmpdir(), 'rv-real-')), emulator: { dir: rp, exe: join(rp, 'rpcs3.exe') }, isRunning: async () => false }
      await cycle(rpcs3Installer, env, info, f, [join(rp, 'dev_hdd0', 'game')])
      rmSync(env.romsDir, { recursive: true, force: true })
    }
  }, 3_600_000)
  if (files.length === 0) it('ps3 : ' + skipMsg('ps3'), () => undefined)
})

describe('contenu réel — Vita / Vita3K', () => {
  const files = list('vita', /\.(vpk|zip|pkg)$/i)
  it.skipIf(files.length === 0)('chaque archive ou paquet : identifié puis installé par Vita3K, suivi exactement (originaux sauvegardés), désinstallé', async () => {
    for (const f of files) {
      const info = await probeFile(f)
      identified(info)
      if (!WITH_EMU) continue
      const vd = join(EMU, 'vita3k')
      const pref = await vita3kPrefPath(vd)
      const T = info.baseKey
      expect(existsSync(join(pref, 'ux0', 'app', T)), `le jeu ${T} doit être installé dans Vita3K (le lancer une fois depuis RomVault)`).toBe(true)
      const env: InstallEnv = { romsDir: mkdtempSync(join(tmpdir(), 'rv-real-')), emulator: { dir: vd, exe: join(vd, 'Vita3K.exe') }, isRunning: async () => false }
      await cycle(vita3kInstaller, env, info, f, [join(pref, 'ux0', 'app', T), join(pref, 'ux0', 'addcont', T), join(pref, 'ux0', 'patch', T), join(pref, 'ux0', 'license', T)])
      rmSync(env.romsDir, { recursive: true, force: true })
    }
  }, 3_600_000)
  if (files.length === 0) it('vita : ' + skipMsg('vita'), () => undefined)
})

describe('contenu réel — Wii U / Cemu', () => {
  const folders = [...dirs('wiiu'), ...list('wiiu', /\.wua$/i)]
  it.skipIf(folders.length === 0)('chaque titre : identifié, prérequis vérifiés, déclaré à Cemu par ses chemins de jeux (et, avec ROMVAULT_REAL_WIIU_BASE, découvert par le VRAI Cemu)', async () => {
    for (const f of folders) {
      const info = statSync(f).isDirectory() ? await probeWiiUFolder(f) : await probeFile(f)
      identified(info)
      if (!WITH_EMU) continue
      const cd = join(EMU, 'cemu')
      const romsDir = mkdtempSync(join(tmpdir(), 'rv-real-'))
      const env: InstallEnv = { romsDir, emulator: { dir: cd, exe: join(cd, 'Cemu.exe') }, isRunning: async () => false }
      const settingsBefore = readFileSync(cemuSettingsFile(cd))
      try {
        // Rangé comme l'import le fait (sous <roms>/wiiu/.content/<jeu>/), puis déclaré à Cemu.
        const stored = await placeContent(f, info, { romsDir, copy: true, deleteSource: false, managed: true })
        const out = await cemuInstaller.install(env, { id: 9101, kind: info.kind as 'update' | 'dlc', path: stored, titleId: info.titleId, version: info.version, needs: null }, { id: 1, console: 'wiiu', title: 'réel', path: 'x', baseKey: info.baseKey }, 'launch')
        expect(out, JSON.stringify(out)).toMatchObject({ state: 'installed' })
        expect(cemuGamePaths(readFileSync(cemuSettingsFile(cd), 'utf8')).length).toBeGreaterThan(0)
        const base = process.env['ROMVAULT_REAL_WIIU_BASE']
        if (base) {
          // Découverte par le VRAI Cemu : le journal doit citer le titre rangé (« Update: » ou « DLC: »).
          const g = guard([join(cd, 'log.txt')])
          try {
            const log = await launchUntil(join(cd, 'Cemu.exe'), ['-g', base], cd, join(cd, 'log.txt'), /DLC: /, 180_000)
            expect(log.replace(/\\/g, '/')).toContain(join(romsDir, 'wiiu', '.content').replace(/\\/g, '/'))
          } finally { g.restore() }
        }
      } finally { writeFileSync(cemuSettingsFile(cd), settingsBefore); rmSync(romsDir, { recursive: true, force: true }) }
    }
  }, 900_000)
  if (folders.length === 0) it('wiiu : ' + skipMsg('wiiu'), () => undefined)
})

