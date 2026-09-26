import { useEffect, useRef } from 'react'
import { heldActions, pickNext, Repeater, type Dir, type PadAction } from './nav'

const KEYS: Record<string, PadAction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Escape: 'back', F11: 'start', PageUp: 'prev', PageDown: 'next', Home: 'prevFilter', End: 'nextFilter' }

/** Racine de focus active : la dernière `[data-focus-root]` du document (une fenêtre superposée prend la main). */
function activeRoot(): HTMLElement | null {
  const roots = document.querySelectorAll<HTMLElement>('[data-focus-root]')
  return roots[roots.length - 1] ?? null
}

export function navItems(): HTMLElement[] {
  return [...(activeRoot()?.querySelectorAll<HTMLElement>('[data-nav]:not([disabled])') ?? [])]
}

export function focusEl(el: HTMLElement | undefined | null): void {
  if (!el) return
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** Déplace le focus vers le voisin de la direction demandée ; sans focus valide, prend le premier élément. */
export function moveFocus(dir: Dir): void {
  const items = navItems()
  if (!items.length) return
  const cur = items.find((i) => i === document.activeElement)
  if (!cur) { focusEl(items[0]); return }
  const box = (e: HTMLElement): { x: number; y: number; w: number; h: number } => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
  // Zone défilable (description d'une fiche) : haut/bas la font défiler tant qu'elle peut, puis le focus reprend sa route.
  if (cur.dataset.scroll !== undefined && (dir === 'up' || dir === 'down')) {
    const room = dir === 'down' ? cur.scrollHeight - cur.clientHeight - cur.scrollTop > 1 : cur.scrollTop > 1
    if (room) { cur.scrollBy({ top: dir === 'down' ? 140 : -140, behavior: 'smooth' }); return }
  }
  const others = items.filter((i) => i !== cur)
  const k = pickNext(box(cur), others.map(box), dir)
  if (k >= 0) focusEl(others[k])
}

/**
 * Branche la manette (API Gamepad, profil standard) et le clavier sur `onAction`.
 * La manette est lue à chaque image ; les directions se répètent en maintien. Le bouton A clique l'élément ciblé.
 * `enabled` à false (jeu en cours) suspend tout : l'émulateur a alors la main.
 */
export function useNav(onAction: (a: PadAction, fromKeyboard: boolean) => void, enabled: boolean): void {
  const cb = useRef(onAction)
  cb.current = onAction
  useEffect(() => {
    if (!enabled) return
    const rep = new Repeater()
    let raf = 0
    const heldNow = (): Set<PadAction> => {
      const held = new Set<PadAction>()
      for (const pad of navigator.getGamepads()) if (pad) heldActions(pad).forEach((a) => held.add(a))
      return held
    }
    // Un bouton déjà maintenu au montage (celui qui a ouvert cet écran) ne compte pas comme un nouvel appui.
    rep.update(heldNow(), performance.now())
    const fire = (a: PadAction, kb = false): void => {
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') moveFocus(a)
      else if (a === 'accept') (document.activeElement as HTMLElement | null)?.click()
      cb.current(a, kb)
    }
    const tick = (now: number): void => {
      rep.update(heldNow(), now).forEach((a) => fire(a))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const key = (e: KeyboardEvent): void => {
      const a = KEYS[e.key]
      if (!a) return
      e.preventDefault()
      fire(a, true)
    }
    window.addEventListener('keydown', key)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', key) }
  }, [enabled])
}
