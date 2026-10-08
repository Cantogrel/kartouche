import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChordHold, nintendoChordDown, onNintendoChord, setNintendoChord } from './nintendoChord'

describe('combinaison de fermeture Nintendo (Moins + Plus)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); setNintendoChord(false) })

  it('se déclenche après la durée demandée, pas avant', () => {
    const fire = vi.fn()
    const h = createChordHold(1500, fire)
    h.feed(true)
    vi.advanceTimersByTime(1499)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('relâcher avant la fin annule', () => {
    const fire = vi.fn()
    const h = createChordHold(1500, fire)
    h.feed(true)
    vi.advanceTimersByTime(1000)
    h.feed(false)
    vi.advanceTimersByTime(5000)
    expect(fire).not.toHaveBeenCalled()
  })

  it('ne se déclenche qu\'une fois par pression, mais de nouveau à la pression suivante', () => {
    const fire = vi.fn()
    const h = createChordHold(1500, fire)
    h.feed(true); h.feed(true)
    vi.advanceTimersByTime(4000)
    expect(fire).toHaveBeenCalledTimes(1)
    h.feed(false); h.feed(true)
    vi.advanceTimersByTime(1500)
    expect(fire).toHaveBeenCalledTimes(2)
  })

  it('tenue déjà enfoncée au début de la surveillance : il faut d\'abord relâcher', () => {
    const fire = vi.fn()
    const h = createChordHold(1500, fire, true)
    h.feed(true)
    vi.advanceTimersByTime(5000)
    expect(fire).not.toHaveBeenCalled()
    h.feed(false); h.feed(true)
    vi.advanceTimersByTime(1500)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('cancel arrête le décompte', () => {
    const fire = vi.fn()
    const h = createChordHold(1500, fire)
    h.feed(true)
    h.cancel()
    vi.advanceTimersByTime(5000)
    expect(fire).not.toHaveBeenCalled()
  })

  it('l\'état est diffusé aux abonnés, jusqu\'à ce qu\'ils se désabonnent', () => {
    const seen: boolean[] = []
    const off = onNintendoChord((d) => seen.push(d))
    setNintendoChord(true)
    expect(nintendoChordDown()).toBe(true)
    setNintendoChord(false)
    off()
    setNintendoChord(true)
    expect(seen).toEqual([true, false])
  })
})
