import { useEffect, useState } from 'react'
import type { DetectedPad } from '@shared/pads'
import { t } from '@/i18n'

/** Manettes branchées (système) et leur interprétation, redemandées toutes les `intervalMs` tant que le composant est affiché. `ready` : la première réponse est arrivée. */
export function usePads(intervalMs = 1500): { pads: DetectedPad[]; ok: boolean; ready: boolean } {
  const [state, setState] = useState<{ pads: DetectedPad[]; ok: boolean; ready: boolean }>({ pads: [], ok: true, ready: false })
  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      try {
        const r = await window.api.invoke('pads:list')
        if (!alive) return
        setState((old) => (old.ready && old.ok === r.ok && JSON.stringify(old.pads) === JSON.stringify(r.pads) ? old : { pads: r.pads, ok: r.ok, ready: true }))
      } catch {
        if (alive) setState((old) => (old.ready && !old.ok ? old : { pads: [], ok: false, ready: true }))
      }
      if (alive) timer = window.setTimeout(() => void tick(), intervalMs)
    }
    void tick()
    return () => { alive = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [intervalMs])
  return state
}

/** Comment Kartouche interprète la manette : « Switch Pro Controller », « Paire de Joy-Con », « Manette XInput »… */
export function padTitle(p: DetectedPad): string {
  switch (p.kind) {
    case 'xinput': return t('pad.xinput')
    case 'switch-pro': return t('pad.switchPro')
    case 'joycon-left': return t('pad.joyconLeft')
    case 'joycon-right': return t('pad.joyconRight')
    case 'joycon-pair': return t('pad.joyconPair')
    default: return p.name || t('pad.other')
  }
}

/** Précisions de la ligne : emplacement XInput, Bluetooth, « dernière utilisée ». */
export function padDetail(p: DetectedPad): string {
  const parts: string[] = []
  if (p.slot !== null) parts.push(t('pad.xinputSlot', { n: p.slot + 1 }))
  if (p.wireless) parts.push(t('pad.bluetooth'))
  if (p.lastUsed) parts.push(t('pad.lastUsed'))
  return parts.join(' · ')
}

/** Étiquettes courtes de la carte : Bluetooth, emplacement XInput, « dernière utilisée ». */
export function padTags(p: DetectedPad): string[] {
  const tags: string[] = []
  if (p.slot !== null) tags.push(t('pad.xinputSlot', { n: p.slot + 1 }))
  if (p.wireless) tags.push(t('pad.bluetooth'))
  if (p.lastUsed) tags.push(t('pad.lastUsed'))
  return tags
}

/** Un Joy-Con gauche et un droit sont allumés (assemblés en paire ou déjà séparés) : l'utilisateur peut choisir de les assembler ou de les séparer. */
export function hasJoyconChoice(pads: readonly DetectedPad[]): boolean {
  return pads.some((p) => p.kind === 'joycon-pair') || (pads.some((p) => p.kind === 'joycon-left') && pads.some((p) => p.kind === 'joycon-right'))
}
