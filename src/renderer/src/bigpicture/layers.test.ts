import { describe, expect, it } from 'vitest'
import { dispatchToLayer, hasLayer, pushLayer } from './layers'

describe('couches du Big Picture', () => {
  it('sans couche, rien n’est traité', () => {
    expect(hasLayer()).toBe(false)
    expect(dispatchToLayer('back')).toBe(false)
  })

  it('la couche du dessus reçoit l’action d’abord et peut la laisser passer', () => {
    const seen: string[] = []
    const off1 = pushLayer((a) => { seen.push(`bas:${a}`); return a === 'back' })
    const off2 = pushLayer((a) => { seen.push(`haut:${a}`); return a === 'prev' })
    expect(dispatchToLayer('prev')).toBe(true)
    expect(dispatchToLayer('back')).toBe(false) // la couche du dessus ne la traite pas : la fiche s'en charge, pas la couche du dessous
    expect(seen).toEqual(['haut:prev', 'haut:back'])
    off2()
    expect(dispatchToLayer('back')).toBe(true)
    off1()
    expect(hasLayer()).toBe(false)
  })

  it('retirer deux fois une couche ne retire pas celle d’un autre', () => {
    const off = pushLayer(() => true)
    const other = pushLayer(() => true)
    off(); off()
    expect(hasLayer()).toBe(true)
    other()
    expect(hasLayer()).toBe(false)
  })
})
