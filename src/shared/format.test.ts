import { describe, expect, it } from 'vitest'
import { formatMinutes, formatSize } from './format'

describe('formatSize', () => {
  it('garde toujours 3 chiffres significatifs, unité adaptée', () => {
    expect(formatSize(560 * 1024)).toBe('560 KB')
    expect(formatSize(3.52 * 1024 * 1024)).toBe('3.52 MB')
    expect(formatSize(59.1 * 1024 * 1024)).toBe('59.1 MB')
    expect(formatSize(876 * 1024 * 1024)).toBe('876 MB')
    expect(formatSize(2.84 * 1024 * 1024 * 1024)).toBe('2.84 GB')
  })

  it('bascule au bon seuil entre unités', () => {
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1.00 KB')
    expect(formatSize(1024 * 1024 - 1)).toBe('1024 KB')
    expect(formatSize(1024 * 1024)).toBe('1.00 MB')
  })

  it('valeurs invalides ou nulles', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(-5)).toBe('0 B')
    expect(formatSize(NaN)).toBe('0 B')
  })
})

describe('formatMinutes', () => {
  it('affiche minutes, heures, ou les deux', () => {
    expect(formatMinutes(0)).toBe('0 min')
    expect(formatMinutes(45)).toBe('45 min')
    expect(formatMinutes(60)).toBe('1 h')
    expect(formatMinutes(125)).toBe('2 h 05')
    expect(formatMinutes(150)).toBe('2 h 30')
    expect(formatMinutes(-5)).toBe('0 min')
    expect(formatMinutes(Number.NaN)).toBe('0 min')
  })
})
