import { BrowserWindow } from 'electron'

/**
 * Rend le premier plan à Kartouche à la fin d'une partie. Sans ça, Windows donne le focus à n'importe quelle autre fenêtre encore ouverte (la fenêtre de menus de RetroArch ou
 * de PPSSPP, le Bureau…) : en Big Picture plein écran la barre des tâches réapparaît et la manette ne répond plus, l'API Gamepad n'étant lue que par la page qui a le focus.
 * Plusieurs tentatives espacées : l'émulateur peut mettre un moment à fermer ses fenêtres, et Windows refuse parfois un premier passage au premier plan.
 * `stillIdle` : faux dès qu'une autre partie a démarré, plus rien à reprendre alors.
 */
export function bringKartoucheToFront(stillIdle: () => boolean, delaysMs: readonly number[] = [0, 400, 1500]): void {
  for (const delay of delaysMs) {
    setTimeout(() => {
      if (!stillIdle()) return
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win || (win.isFocused() && win.isVisible() && !win.isMinimized())) return
      if (win.isMinimized()) win.restore()
      win.show()
      // Windows n'accorde le premier plan qu'à l'application qui l'a déjà : passer un instant « toujours au-dessus » contourne ce refus.
      win.setAlwaysOnTop(true)
      win.focus()
      win.moveTop()
      win.setAlwaysOnTop(false)
      win.webContents.focus()
    }, delay)
  }
}
