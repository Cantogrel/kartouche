/**
 * Combinaison de fermeture des manettes Nintendo : Moins + Plus tenus ensemble (voir `watchNintendoHid` : sur la Switch Pro, ou Moins du Joy-Con gauche + Plus du Joy-Con droit).
 * Un Joy-Con seul : Moins + Capture (gauche) ou Home + Plus (droit).
 */
let down = false
const listeners = new Set<(down: boolean) => void>()

/** Mis à jour par la lecture des manettes Nintendo. */
export function setNintendoChord(value: boolean): void {
  down = value
  for (const l of [...listeners]) l(value)
}

/** Reçoit chaque changement d'état de la combinaison ; renvoie la fonction qui se désabonne. */
export function onNintendoChord(listener: (down: boolean) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const nintendoChordDown = (): boolean => down

/**
 * Appelle `onFire` quand la combinaison est tenue `holdMs` d'affilée. Une combinaison déjà tenue au moment où on commence à surveiller (partie lancée en la tenant) ne compte pas :
 * il faut la relâcher d'abord. `feed` reçoit les changements d'état ; `cancel` arrête tout.
 */
export function createChordHold(holdMs: number, onFire: () => void, startedDown = false): { feed: (down: boolean) => void; cancel: () => void } {
  let armed = !startedDown
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = (): void => { if (timer) { clearTimeout(timer); timer = null } }
  return {
    feed(value) {
      if (!value) { armed = true; stop(); return }
      if (!armed || timer) return
      timer = setTimeout(() => { timer = null; onFire() }, holdMs)
    },
    cancel: stop
  }
}
