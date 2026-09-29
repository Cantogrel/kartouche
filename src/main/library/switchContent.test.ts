import { describe, expect, it } from 'vitest'
import { classifySwitchTitleId, switchContentFromFilename } from './switchContent'

// The Legend of Zelda: Breath of the Wild — Title IDs from Nintendo's public documentation.
const BASE = '01007EF00011E000'
const UPDATE = '01007EF00011E800'
const DLC1 = '01007EF00011F001'
const DLC2 = '01007EF00011F002'

describe('classifySwitchTitleId', () => {
  it('recognizes a base game', () => {
    expect(classifySwitchTitleId(BASE)).toEqual({ kind: 'base', titleId: BASE, baseTitleId: BASE })
  })
  it('recognizes an update and points back to its base', () => {
    expect(classifySwitchTitleId(UPDATE)).toEqual({ kind: 'update', titleId: UPDATE, baseTitleId: BASE })
  })
  it('recognizes DLC and points back to its base regardless of index', () => {
    expect(classifySwitchTitleId(DLC1)).toEqual({ kind: 'dlc', titleId: DLC1, baseTitleId: BASE })
    expect(classifySwitchTitleId(DLC2)).toEqual({ kind: 'dlc', titleId: DLC2, baseTitleId: BASE })
  })
  it('is case-insensitive', () => {
    expect(classifySwitchTitleId(UPDATE.toLowerCase())).toEqual({ kind: 'update', titleId: UPDATE, baseTitleId: BASE })
  })
})

describe('switchContentFromFilename', () => {
  it('finds a bracketed Title ID', () => {
    expect(switchContentFromFilename(`Super Smash Bros. Ultimate [${UPDATE}][v0]`)).toEqual({ kind: 'update', titleId: UPDATE, baseTitleId: BASE })
  })
  it('finds a parenthesized Title ID', () => {
    expect(switchContentFromFilename(`Zelda BOTW (${DLC1})`)).toEqual({ kind: 'dlc', titleId: DLC1, baseTitleId: BASE })
  })
  it('returns null when no Title ID and no update/DLC keyword is present', () => {
    expect(switchContentFromFilename('Super Smash Bros. Ultimate')).toBeNull()
  })
  // Dump réel sans Title ID dans le nom : seul le mot « Update » permet de le classer (voir findSwitchBase dans importer.ts).
  it('falls back to the "update" keyword when there is no Title ID', () => {
    expect(switchContentFromFilename('Super Smash Bros. Ultimate Switch NSP Update v2031616')).toEqual({ kind: 'update', titleId: '', baseTitleId: '' })
  })
  it('falls back to the "DLC"/"add-on" keyword when there is no Title ID', () => {
    expect(switchContentFromFilename('Super Smash Bros Ultimate DLC Pack')).toEqual({ kind: 'dlc', titleId: '', baseTitleId: '' })
    expect(switchContentFromFilename('Super Smash Bros Ultimate Add-on Content')).toEqual({ kind: 'dlc', titleId: '', baseTitleId: '' })
  })
})
