import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from './genericLaunch'

const NODE = process.execPath

describe('runProcess', () => {
  it('lance un vrai processus, capture sa sortie et renvoie son code et sa durée', async () => {
    const h = runProcess({ exe: NODE, args: ['-e', "console.log('bonjour'); console.error('attention'); setTimeout(() => process.exit(3), 150)"] })
    expect(h.pid).toBeGreaterThan(0)
    const o = await h.done
    expect(o.exitCode).toBe(3)
    expect(o.captured).toContain('bonjour')
    expect(o.captured).toContain('attention')
    expect(o.elapsedMs).toBeGreaterThanOrEqual(100)
    expect(o.error).toBeUndefined()
  })

  it('un exécutable introuvable ne lève pas : pid 0 et l’erreur dans le résultat', async () => {
    const h = runProcess({ exe: 'C:\\n\\existe\\pas\\x.exe', args: [] })
    expect(h.pid).toBe(0)
    const o = await h.done
    expect(o.exitCode).toBeNull()
    expect(o.error).toMatch(/ENOENT/)
  })

  it('transmet le dossier de travail et l’environnement', async () => {
    const h = runProcess({ exe: NODE, args: ['-e', 'console.log(process.cwd().length > 0, process.env.KARTOUCHE_TEST)'], env: { ...process.env, KARTOUCHE_TEST: 'ok' } })
    expect((await h.done).captured).toContain('true ok')
  })

  it.runIf(process.platform === 'win32')('lance un .bat (Node refuse sinon : EINVAL) avec ses arguments, espaces compris', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kbat-'))
    try {
      const bat = join(dir, 'mon yuzu.bat')
      writeFileSync(bat, '@echo off\r\necho [%~1][%~2]\r\nexit /b 7\r\n')
      const o = await runProcess({ exe: bat, args: ['C:\\Mes jeux\\a b.nsp', 'switch'] }).done
      expect(o.error).toBeUndefined()
      expect(o.exitCode).toBe(7)
      expect(o.captured).toContain('[C:\\Mes jeux\\a b.nsp][switch]')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('un argument avec espaces, guillemets ou caractères spéciaux arrive tel quel (pas de passage par un interpréteur de commandes)', async () => {
    const tricky = 'a b "c" & echo piraté | x'
    const h = runProcess({ exe: NODE, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', tricky] })
    expect(JSON.parse((await h.done).captured.trim())).toEqual([tricky])
  })
})
