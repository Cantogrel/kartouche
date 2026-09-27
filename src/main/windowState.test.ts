import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './db/migrations'
import { loadWindowState, saveWindowState } from './windowState'

const db = (): DatabaseSync => { const d = new DatabaseSync(':memory:'); migrate(d); return d }

describe('windowState', () => {
  it('rien de sauvegardé : null', () => {
    expect(loadWindowState(db())).toBeNull()
  })
  it('sauvegarde puis relit les bornes et l’état maximisé', () => {
    const d = db()
    saveWindowState(d, { width: 1600, height: 900, x: 10, y: 20, maximized: true })
    expect(loadWindowState(d)).toEqual({ width: 1600, height: 900, x: 10, y: 20, maximized: true })
  })
  it('une valeur stockée invalide (corrompue, mauvais type) redevient null', () => {
    const d = db()
    d.prepare("INSERT INTO settings (key, value) VALUES ('_windowState', 'pas du json')").run()
    expect(loadWindowState(d)).toBeNull()
    d.prepare("UPDATE settings SET value = '{\"width\":\"x\"}' WHERE key = '_windowState'").run()
    expect(loadWindowState(d)).toBeNull()
  })
  it('x/y absents (fenêtre laissée au placement automatique) restent absents', () => {
    const d = db()
    saveWindowState(d, { width: 1400, height: 860, maximized: false })
    expect(loadWindowState(d)).toEqual({ width: 1400, height: 860, x: undefined, y: undefined, maximized: false })
  })
})
