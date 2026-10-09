import { useEffect } from 'react'
import { useApp, type Route } from '@/store/app'
import { useSettings } from '@/store/settings'
import { isJoyconPair, padActions, pickNext, Repeater, rightStickScroll, type Dir, type PadAction } from '@/bigpicture/nav'

// Un minimum de manette dans le mode classique : directions (stick ou croix) = focus voisin, A = cliquer, B = retour (ou fermer la fenêtre ouverte), stick droit = défilement,
// L1/R1 = section précédente / suivante du menu de gauche, Y = menu de gauche ↔ page, L2/R2 = page haut / bas, Start (Plus) = Big Picture. Le Big Picture a son propre moteur (`useNav`) ; celui-ci ne tourne que hors Big Picture.
const SECTIONS: Exclude<Route, 'game'>[] = ['home', 'catalog', 'library', 'emulators', 'settings']
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** Zone où le focus circule : la fenêtre ouverte la plus récente, sinon toute l'application. */
function root(): HTMLElement | null {
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]')
  return dialogs[dialogs.length - 1] ?? document.querySelector<HTMLElement>('.app')
}

function visible(el: HTMLElement): boolean {
  if (el.matches(':disabled, [aria-hidden="true"], a.skip, input[type="hidden"]')) return false
  // Barre de titre : seuls le Big Picture et la pastille de mise à jour (jamais réduire / agrandir / fermer la fenêtre par mégarde).
  if (el.closest('.titlebar') && !el.matches('.bp-launch, .update-badge')) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function items(): HTMLElement[] {
  return [...(root()?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(visible)
}

const isText = (el: Element | null): boolean => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type))

function focusEl(el: HTMLElement): void {
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function move(dir: Dir): void {
  const list = items()
  if (!list.length) return
  const cur = document.activeElement as HTMLElement | null
  if (!cur || !list.includes(cur)) {
    // Rien de ciblé : on prend le premier élément du contenu de la page (pas le menu de gauche), sinon le premier venu.
    focusEl(list.find((e) => e.closest('.main')) ?? list[0])
    return
  }
  // Curseur de réglage : gauche/droite changent la valeur au lieu de quitter le curseur.
  if (cur instanceof HTMLInputElement && cur.type === 'range' && (dir === 'left' || dir === 'right')) {
    if (dir === 'left') cur.stepDown(); else cur.stepUp()
    cur.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  // Dans un champ de texte, gauche/droite restent au curseur de saisie.
  if (isText(cur) && (dir === 'left' || dir === 'right')) return
  const box = (e: HTMLElement): { x: number; y: number; w: number; h: number } => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } }
  // On reste d'abord dans la zone de l'élément ciblé (menu de gauche, page, barre de titre) : sinon, de la page, « bas » sautait dans le menu. Hors zone seulement s'il n'y a rien d'autre dans cette direction.
  const region = (e: HTMLElement): string => (e.closest('.sidebar') ? 'side' : e.closest('.titlebar') ? 'title' : 'main')
  for (const pool of [list.filter((e) => e !== cur && region(e) === region(cur)), list.filter((e) => e !== cur)]) {
    const k = pickNext(box(cur), pool.map(box), dir)
    if (k >= 0) { focusEl(pool[k]); return }
  }
}

/** Élément à faire défiler : le plus proche parent défilable de la cible, sinon le contenu de la page. */
function scroller(): HTMLElement | null {
  for (let el = document.activeElement as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && !el.closest('.sidebar')) return el
  }
  return document.querySelector<HTMLElement>('.main .content')
}

/** Premier élément à cibler sur la page : le bouton principal (Jouer…), sinon la première carte, sinon le premier élément du contenu. */
function focusPage(): void {
  const list = items().filter((e) => e.closest('.main'))
  const pick = list.find((e) => e.matches('.btn.primary')) ?? list.find((e) => e.matches('.card, .row-card')) ?? list.find((e) => e.closest('.content')) ?? list[0]
  if (pick) focusEl(pick)
}

/** Passe du menu de gauche à la page, et inversement. */
function switchRegion(): void {
  if (document.activeElement?.closest('.sidebar')) { focusPage(); return }
  const cur = items().find((e) => e.closest('.sidebar') && e.matches('[aria-current="page"], .active'))
  if (cur) focusEl(cur)
}

function act(a: PadAction): void {
  if (a === 'up' || a === 'down' || a === 'left' || a === 'right') { move(a); return }
  if (a === 'accept') {
    const el = document.activeElement as HTMLElement | null
    if (el && el !== document.body && !isText(el)) el.click()
    return
  }
  if (a === 'back') {
    const cur = document.activeElement as HTMLElement | null
    // Dans un champ de texte, B ne doit pas quitter la page : on en sort d'abord.
    if (isText(cur)) { cur?.blur(); return }
    // Fenêtre, menu ou galerie ouverts : même effet qu'Échap (ils l'écoutent tous).
    if (document.querySelector('[role="dialog"], .ctx, .menu')) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return }
    const app = useApp.getState()
    if (app.history.length) app.back()
    return
  }
  if (a === 'start') { useApp.getState().setBigPicture(true); return }
  if (a === 'y') { switchRegion(); return }
  // Gâchettes (ZL/ZR, L2/R2) : une page vers le haut ou vers le bas.
  if (a === 'prevFilter' || a === 'nextFilter') {
    const el = scroller()
    if (el) el.scrollBy({ top: (a === 'nextFilter' ? 1 : -1) * el.clientHeight * 0.8, behavior: 'smooth' })
    return
  }
  if (a === 'prev' || a === 'next') {
    if (document.querySelector('[role="dialog"]')) return
    const app = useApp.getState()
    const at = SECTIONS.indexOf(app.route === 'game' ? (app.gameId?.startsWith('lib:') ? 'library' : 'catalog') : app.route)
    app.go(SECTIONS[(at + (a === 'next' ? 1 : SECTIONS.length - 1)) % SECTIONS.length])
  }
}

/** Branche la manette (API Gamepad) sur l'interface classique. `enabled` faux (Big Picture) : rien. */
export function useClassicPad(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const rep = new Repeater()
    const html = document.documentElement
    const held = (): Set<PadAction> => {
      const out = new Set<PadAction>()
      const { joyconSplit, padThreshold } = useSettings.getState().settings
      for (const pad of navigator.getGamepads()) if (pad) padActions(pad, { split: joyconSplit, threshold: padThreshold }).forEach((a) => out.add(a))
      return out
    }
    // Un bouton déjà maintenu au démarrage, ou au retour dans la fenêtre (fin d'une partie), ne compte pas comme un appui.
    const prime = (): void => { rep.update(held(), performance.now()) }
    prime()
    let raf = 0
    const tick = (now: number): void => {
      const fired = rep.update(held(), now)
      fired.forEach(act)
      if (fired.length) html.classList.add('pad-nav')
      // Joy-Con séparés : le stick du Joy-Con droit sert de direction, pas de défilement.
      const delta = rightStickScroll([...navigator.getGamepads()].filter((p) => !(p && useSettings.getState().settings.joyconSplit && isJoyconPair(p))), 0.15, 6)
      if (delta) { const el = scroller(); if (el) el.scrollTop += delta }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    // Page ouverte à la manette : le focus y est déjà (bouton Jouer d'une fiche, première carte…), sans repartir du menu de gauche.
    let last = `${useApp.getState().route}/${useApp.getState().gameId ?? ''}`
    const unsub = useApp.subscribe((s) => {
      const now = `${s.route}/${s.gameId ?? ''}`
      if (now === last) return
      last = now
      if (html.classList.contains('pad-nav')) window.setTimeout(focusPage, 250)
    })
    // La souris ou le clavier reprennent la main : le contour de focus de la manette disparaît.
    const quiet = (): void => html.classList.remove('pad-nav')
    window.addEventListener('focus', prime)
    window.addEventListener('mousedown', quiet)
    window.addEventListener('keydown', quiet)
    return () => {
      cancelAnimationFrame(raf)
      unsub()
      window.removeEventListener('focus', prime)
      window.removeEventListener('mousedown', quiet)
      window.removeEventListener('keydown', quiet)
      html.classList.remove('pad-nav')
    }
  }, [enabled])
}
