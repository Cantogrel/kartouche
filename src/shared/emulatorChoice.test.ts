import { describe, expect, it } from 'vitest'
import type { CustomEmulator } from './customEmulators'
import { chooseEmulator, emulatorOptions, resolveEmulatorId } from './emulatorChoice'

const mine: CustomEmulator = { id: 'custom-1', name: 'Mon SNES', exe: 'C:\\e\\snes.exe', args: '"{rom}"', consoles: ['snes'], extensions: ['sfc', 'smc'] }
const other: CustomEmulator = { id: 'custom-2', name: 'Autre', exe: 'C:\\e\\autre.exe', args: '"{rom}"', consoles: ['snes', 'gb'], extensions: [] }
const base = { console: 'snes', file: 'D:\\roms\\Zelda.sfc', entryChoice: null, defaults: {}, customs: [mine, other] }

describe('chooseEmulator', () => {
  it('sans choix, prend l’émulateur intégré de la console', () => {
    const c = chooseEmulator(base)
    expect(c).toMatchObject({ kind: 'builtin', def: { id: 'retroarch' } })
  })

  it('le choix fait pour le jeu passe avant tout', () => {
    expect(chooseEmulator({ ...base, entryChoice: 'custom-1', defaults: { snes: 'custom-2' } })).toMatchObject({ kind: 'custom', emulator: { id: 'custom-1' } })
  })

  it('puis l’émulateur par défaut de la console', () => {
    expect(chooseEmulator({ ...base, defaults: { snes: 'custom-2' } })).toMatchObject({ kind: 'custom', emulator: { id: 'custom-2' } })
    expect(chooseEmulator({ ...base, defaults: { snes: 'retroarch' } })).toMatchObject({ kind: 'builtin', def: { id: 'retroarch' } })
  })

  it('un choix devenu invalide est ignoré (émulateur supprimé, extension refusée, console non gérée)', () => {
    expect(chooseEmulator({ ...base, entryChoice: 'custom-9' })).toMatchObject({ kind: 'builtin' })
    expect(chooseEmulator({ ...base, file: 'D:\\roms\\Zelda.zip', entryChoice: 'custom-1' })).toMatchObject({ kind: 'builtin' }) // custom-1 n'accepte que sfc/smc
    expect(chooseEmulator({ ...base, entryChoice: 'dolphin' })).toMatchObject({ kind: 'builtin', def: { id: 'retroarch' } }) // Dolphin ne lance pas la SNES
    expect(chooseEmulator({ ...base, defaults: { snes: 'custom-9' } })).toMatchObject({ kind: 'builtin' })
  })

  it('rien ne lance une console inconnue ou « pc » (entrées non-ROM : lancées sans émulateur) si aucun émulateur personnalisé ne l’accepte', () => {
    expect(chooseEmulator({ ...base, console: 'megadrive', file: 'x.md' })).toBeNull()
    expect(chooseEmulator({ ...base, console: 'pc', file: 'x.exe' })).toBeNull()
  })

  it('à défaut d’émulateur intégré, un émulateur personnalisé qui accepte la console prend le relais', () => {
    expect(chooseEmulator({ ...base, console: 'megadrive', file: 'x.md', customs: [{ ...other, consoles: ['megadrive'] }] })).toMatchObject({ kind: 'custom', emulator: { id: 'custom-2' } })
  })
})

describe('resolveEmulatorId / emulatorOptions', () => {
  it('ne valide un identifiant que s’il sait lancer ce jeu', () => {
    expect(resolveEmulatorId('retroarch', base)).toMatchObject({ kind: 'builtin' })
    expect(resolveEmulatorId('dolphin', base)).toBeNull()
    expect(resolveEmulatorId('custom-2', base)).toMatchObject({ kind: 'custom' })
    expect(resolveEmulatorId(null, base)).toBeNull()
    expect(resolveEmulatorId('custom-1; calc', base)).toBeNull()
  })

  it('liste l’émulateur intégré puis les personnalisés qui acceptent le fichier', () => {
    expect(emulatorOptions(base).map((o) => `${o.kind}:${o.id}`)).toEqual(['builtin:retroarch', 'custom:custom-1', 'custom:custom-2'])
    expect(emulatorOptions({ ...base, file: 'D:\\roms\\Zelda.zip' }).map((o) => o.id)).toEqual(['retroarch', 'custom-2'])
    expect(emulatorOptions({ ...base, console: 'gb', file: 'a.gb' }).map((o) => o.id)).toEqual(['retroarch', 'custom-2'])
  })
})
