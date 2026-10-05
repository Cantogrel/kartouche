import { describe, expect, it } from 'vitest'
import { buildCustomCommand, customEmulatorAccepts, formatCommand, isCustomEmulatorId, splitArgs, validateCustomEmulator } from './customEmulators'

const ok = { name: 'Mon émulateur', exe: 'C:\\Emus\\mon.exe', args: '-f "{rom}"', consoles: ['snes', 'nes'], extensions: ['.SFC', 'smc', 'sfc'] }

describe('validateCustomEmulator', () => {
  it('accepte une saisie correcte et la nettoie (extensions sans point, en minuscules, sans doublon)', () => {
    const r = validateCustomEmulator({ ...ok, name: '  Mon émulateur  ' })
    expect(r).toEqual({ ok: true, value: { name: 'Mon émulateur', exe: 'C:\\Emus\\mon.exe', args: '-f "{rom}"', consoles: ['snes', 'nes'], extensions: ['sfc', 'smc'] } })
  })

  it('applique le modèle d’arguments par défaut quand il est absent ou vide', () => {
    expect(validateCustomEmulator({ ...ok, args: undefined })).toMatchObject({ ok: true, value: { args: '"{rom}"' } })
    expect(validateCustomEmulator({ ...ok, args: '   ' })).toMatchObject({ ok: true, value: { args: '"{rom}"' } })
  })

  it('désigne le premier champ en défaut', () => {
    expect(validateCustomEmulator({ ...ok, name: '  ' })).toEqual({ ok: false, error: 'name' })
    expect(validateCustomEmulator({ ...ok, name: 'x'.repeat(61) })).toEqual({ ok: false, error: 'name' })
    for (const exe of ['', 'C:\\Emus\\mon.txt', 'C:\\Emus\\a|b.exe', 'x'.repeat(530) + '.exe']) expect(validateCustomEmulator({ ...ok, exe })).toEqual({ ok: false, error: 'exe' })
    expect(validateCustomEmulator({ ...ok, args: 'x'.repeat(2001) })).toEqual({ ok: false, error: 'args' })
    expect(validateCustomEmulator({ ...ok, consoles: ['snes', 'megadrive'] })).toEqual({ ok: false, error: 'consoles' })
    expect(validateCustomEmulator({ ...ok, extensions: ['sfc', 'pas un ext'] })).toEqual({ ok: false, error: 'extensions' })
    expect(validateCustomEmulator(null)).toEqual({ ok: false, error: 'name' })
  })

  it('reconnaît les identifiants personnalisés et eux seuls', () => {
    expect(isCustomEmulatorId('custom-3')).toBe(true)
    for (const id of ['retroarch', 'custom-', 'custom-x', 'custom-3; rm', null, undefined, '']) expect(isCustomEmulatorId(id as never)).toBe(false)
  })
})

describe('splitArgs / buildCustomCommand', () => {
  it('découpe comme une ligne de commande, guillemets groupant les espaces', () => {
    expect(splitArgs('-f "{rom}" --opt=1')).toEqual(['-f', '{rom}', '--opt=1'])
    expect(splitArgs('  a   "b c"  "" d ')).toEqual(['a', 'b c', '', 'd'])
    expect(splitArgs('')).toEqual([])
  })

  it('remplace les variables par argument : un chemin avec espaces reste un seul argument', () => {
    const cmd = buildCustomCommand({ exe: 'C:\\Emus\\mon.exe', args: '-f "{rom}" --dir {dir} --n {name} --c {console}' }, { rom: 'D:\\Jeux perso\\Super Mario World (USA).sfc', console: 'snes' })
    expect(cmd.exe).toBe('C:\\Emus\\mon.exe')
    expect(cmd.args).toEqual(['-f', 'D:\\Jeux perso\\Super Mario World (USA).sfc', '--dir', 'D:\\Jeux perso', '--n', 'Super Mario World (USA)', '--c', 'snes'])
  })

  it('un chemin qui contient des guillemets ou des espaces ne peut pas injecter d’argument', () => {
    const cmd = buildCustomCommand({ exe: 'e.exe', args: '{rom}' }, { rom: 'D:\\x" --evil "y.sfc' })
    expect(cmd.args).toEqual(['D:\\x" --evil "y.sfc'])
  })

  it('formatCommand met entre guillemets ce qui contient des espaces', () => {
    expect(formatCommand({ exe: 'C:\\Mon Emu\\e.exe', args: ['-f', 'D:\\a b\\c.sfc'] })).toBe('"C:\\Mon Emu\\e.exe" -f "D:\\a b\\c.sfc"')
  })
})

describe('customEmulatorAccepts', () => {
  it('exige la console et, si la liste n’est pas vide, l’extension', () => {
    const emu = { consoles: ['snes'], extensions: ['sfc', 'smc'] }
    expect(customEmulatorAccepts(emu, 'snes', 'Jeu.SFC')).toBe(true)
    expect(customEmulatorAccepts(emu, 'snes', 'Jeu.zip')).toBe(false)
    expect(customEmulatorAccepts(emu, 'nes', 'Jeu.sfc')).toBe(false)
    expect(customEmulatorAccepts({ consoles: ['snes'], extensions: [] }, 'snes', 'nimporte.quoi')).toBe(true)
    expect(customEmulatorAccepts(emu, 'snes', 'sans-extension')).toBe(false)
  })
})
