import { describe, expect, it } from 'vitest'
import { launchCheckPath, parseLaunchSpec } from './launch'
import { platformLabel } from './consoles'

describe('parseLaunchSpec', () => {
  it('lit une spécification exe, en texte JSON ou en objet, et nettoie les champs', () => {
    expect(parseLaunchSpec({ type: 'exe', exe: ' C:\\Jeux\\Jeu.exe ', args: '-windowed', cwd: 'C:\\Jeux' })).toEqual({ type: 'exe', exe: 'C:\\Jeux\\Jeu.exe', args: '-windowed', cwd: 'C:\\Jeux' })
    expect(parseLaunchSpec(JSON.stringify({ type: 'exe', exe: 'a.exe', inconnu: 1 }))).toEqual({ type: 'exe', exe: 'a.exe' })
  })

  it('lit une spécification uri avec repli exe et dossier d’installation', () => {
    expect(parseLaunchSpec({ type: 'uri', uri: 'steam://rungameid/10', exe: 'x.exe', installDir: 'D:\\Steam\\x' })).toEqual({ type: 'uri', uri: 'steam://rungameid/10', exe: 'x.exe', installDir: 'D:\\Steam\\x' })
  })

  it('refuse ce qui ne permet rien de lancer', () => {
    for (const bad of [null, undefined, 42, '', 'pas du json', '{"type":"exe"}', { type: 'exe', exe: '  ' }, { type: 'uri' }, { type: 'autre', exe: 'a.exe' }, { type: 'exe', exe: 'x'.repeat(600) }, []]) {
      expect(parseLaunchSpec(bad)).toBeNull()
    }
  })
})

describe('launchCheckPath / platformLabel', () => {
  it('vérifie l’exécutable, sinon le dossier d’installation, sinon rien', () => {
    expect(launchCheckPath({ type: 'exe', exe: 'a.exe', installDir: 'd' })).toBe('a.exe')
    expect(launchCheckPath({ type: 'uri', uri: 'steam://x', installDir: 'd' })).toBe('d')
    expect(launchCheckPath({ type: 'uri', uri: 'steam://x' })).toBeNull()
  })

  it('nomme « PC » la plateforme des entrées non-ROM, et garde le nom des consoles', () => {
    expect(platformLabel('pc')).toBe('PC')
    expect(platformLabel('snes')).toBe('SNES')
    expect(platformLabel('inconnue')).toBe('inconnue')
  })
})
