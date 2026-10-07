import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preferActive, rankAmong } from './padChoice'
import { applyMelondsPad } from './configure'

describe('manette à lire', () => {
  it('met en premier la manette sur laquelle on a appuyé, le reste dans l\'ordre', () => {
    expect(preferActive([0, 1, 2], (s) => s, 2)).toEqual([2, 0, 1])
    expect(preferActive([0, 1, 2], (s) => s, 0)).toEqual([0, 1, 2])
  })
  it('garde l\'ordre de Windows sans information ou si la manette active est débranchée', () => {
    expect(preferActive([0, 1], (s) => s, null)).toEqual([0, 1])
    expect(preferActive([0, 1], (s) => s, 3)).toEqual([0, 1])
  })
  it('donne à melonDS le rang de la manette parmi les manettes branchées', () => {
    expect(rankAmong([0, 1, 2], 2)).toBe(2)
    expect(rankAmong([1, 3], 3)).toBe(1)
  })
  it('réécrit JoystickID de melonDS sans toucher au reste', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melon-'))
    await writeFile(join(dir, 'melonDS.toml'), '[Instance0]\nJoystickID = 0\nOther = 5\n\n[Instance0.Keyboard]\nA = 76\n')
    await applyMelondsPad(dir, 2)
    expect(await readFile(join(dir, 'melonDS.toml'), 'utf8')).toBe('[Instance0]\nJoystickID = 2\nOther = 5\n\n[Instance0.Keyboard]\nA = 76\n')
    await applyMelondsPad(dir, null)
    expect(await readFile(join(dir, 'melonDS.toml'), 'utf8')).toContain('JoystickID = 2')
  })
})
