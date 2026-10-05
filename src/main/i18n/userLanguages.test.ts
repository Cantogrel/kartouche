import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importUserLanguage, languagesDir, listUserLanguages, removeUserLanguage } from './userLanguages'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kart-lang-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const src = (name: string, o: Record<string, unknown>): string => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify({ format: 'kartouche.lang/v1', code: 'es', name: 'Español', strings: { play: 'Jugar' }, ...o }))
  return p
}

describe('langues utilisateur', () => {
  it('importe, liste puis retire un fichier de langue', async () => {
    expect(await listUserLanguages(dir)).toEqual([])
    const r = await importUserLanguage(dir, src('es-source.json', {}))
    expect(r.ok).toBe(true)
    expect(await listUserLanguages(dir)).toEqual([{ code: 'es', name: 'Español', strings: { play: 'Jugar' } }])
    expect(await removeUserLanguage(dir, 'es')).toBe(true)
    expect(await listUserLanguages(dir)).toEqual([])
  })
  it('refuse un fichier invalide sans rien écrire', async () => {
    const r = await importUserLanguage(dir, src('bad.json', { code: 'fr' }))
    expect(r).toEqual({ ok: false, error: 'builtin' })
    expect(existsSync(languagesDir(dir))).toBe(false)
  })
  it('un code qui sort du dossier est refusé au retrait', async () => {
    expect(await removeUserLanguage(dir, '../x')).toBe(false)
  })
})
