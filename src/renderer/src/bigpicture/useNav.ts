import { useEffect, useRef } from 'react'
import { useSettings } from '@/store/settings'
import type { Settings } from '@shared/settings'
import { isJoyconPair, padActions, pickNext, Repeater, rightStickScroll, type Dir, type PadAction } from './nav'

const KEYS: Record<string, PadAction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Escape: 'back', F11: 'start', PageUp: 'prev', PageDown: 'next', Home: 'prevFilter', End: 'nextFilter' }

/**
 * Saisie au clavier physique d'un texte (recherche) : caractères imprimables et Retour arrière, sans toucher aux
 * raccourcis (Ctrl/Alt/Méta). L'espace n'est pris qu'une fois du texte saisi, sinon il garde son rôle de clic sur l'élément focalisé.
 */
export function useTypeText(value: string, onChange: (v: string) => void, enabled: boolean): void {
  const cur = useRef({ value, onChange })
  cur.current = { value, onChange }
  useEffect(() => {
    if (!enabled) return
    const key = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const { value: v, onChange: set } = cur.current
      if (e.key === 'Backspace') { if (v) { e.preventDefault(); set(v.slice(0, -1)) } }
      else if (e.key.length === 1 && (e.key !== ' ' || v)) { e.preventDefault(); set(v + e.key.toLowerCase()) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [enabled])
}

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
  // Coordonnées indépendantes du défilement : un élément de la zone `[data-scroll]` garde sa position dans le flux
  // même hors champ, sinon il se retrouve géométriquement "loin" une fois scrollé et un élément fixe hors de cette
  // zone (ex. le ☰ du header, jamais affecté par le scroll) gagne la navigation à sa place — vécu sur l'Accueil :
  // remonter depuis une rangée qui n'est plus la toute première envoyait le focus sur le menu au lieu de la rangée
  // juste au-dessus, dès que le défilement avait poussé cette rangée hors de l'écran.
  const scroller = activeRoot()?.querySelector<HTMLElement>('[data-scroll]') ?? null
  const box = (e: HTMLElement): { x: number; y: number; w: number; h: number } => {
    const r = e.getBoundingClientRect()
    const dy = scroller?.contains(e) ? scroller.scrollTop : 0
    return { x: r.left, y: r.top + dy, w: r.width, h: r.height }
  }
  // Zone défilable (description d'une fiche) : haut/bas la font défiler tant qu'elle peut, puis le focus reprend sa route.
  if (cur.dataset.scroll !== undefined && (dir === 'up' || dir === 'down')) {
    const room = dir === 'down' ? cur.scrollHeight - cur.clientHeight - cur.scrollTop > 1 : cur.scrollTop > 1
    if (room) { cur.scrollBy({ top: dir === 'down' ? 140 : -140, behavior: 'smooth' }); return }
  }
  const others = items.filter((i) => i !== cur)
  const k = pickNext(box(cur), others.map(box), dir)
  if (k >= 0) focusEl(others[k])
}

const cfg = (): Settings => useSettings.getState().settings

/** Défilement continu au stick droit de la zone `[data-scroll]` de l'écran actif, quel que soit l'élément ciblé par le stick gauche. */
function scrollWithRightStick(): void {
  // Joy-Con séparés : le stick du Joy-Con droit sert de direction, pas de défilement.
  const delta = rightStickScroll([...navigator.getGamepads()].filter((p) => !(p && cfg().joyconSplit && isJoyconPair(p))), 0.15, 6)
  if (!delta) return
  const el = activeRoot()?.querySelector<HTMLElement>('[data-scroll]')
  if (el) el.scrollTop += delta
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
      for (const pad of navigator.getGamepads()) if (pad) padActions(pad, { split: cfg().joyconSplit, threshold: cfg().padThreshold }).forEach((a) => held.add(a))
      return held
    }
    // Un bouton déjà maintenu au montage (celui qui a ouvert cet écran) ne compte pas comme un nouvel appui.
    rep.update(heldNow(), performance.now())
    const fire = (a: PadAction, kb = false): void => {
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') moveFocus(a)
      else if (a === 'accept') {
        const el = document.activeElement as HTMLElement | null
        // Retour de clic à la manette (le :active du CSS ne joue qu'à la souris) : le bouton s'enfonce un instant.
        if (el?.classList.contains('bp-btn')) { el.classList.add('pressed'); window.setTimeout(() => el.classList.remove('pressed'), 140) }
        el?.click()
      }
      cb.current(a, kb)
    }
    const tick = (now: number): void => {
      rep.update(heldNow(), now).forEach((a) => fire(a))
      scrollWithRightStick()
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
