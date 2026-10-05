import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Revue automatique de la règle de shared/connectors.ts : aucun connecteur ne lit de secret de compte (identifiants, jetons, sessions) ni ne contacte
 * un service du launcher. Les fichiers qui contiennent ces fichiers/mots sont refusés, quel que soit le launcher ajouté par la suite.
 */
const FORBIDDEN: [RegExp, string][] = [
  [/loginusers\.vdf/i, 'comptes Steam'],
  [/ssfn/i, 'sentinelle Steam'],
  [/\bpassword\b/i, 'mot de passe'],
  [/\b(access|refresh|auth)[_-]?token\b/i, 'jeton'],
  [/\bcookies?\b/i, 'cookies de session'],
  [/\bsafeStorage\b|\bDPAPI\b|CryptUnprotect/i, 'déchiffrement de secrets'],
  [/\bfetch\s*\(|\bhttps?\.request\b|\bnet\.request\b|\bXMLHttpRequest\b|from 'node:(http|https|net)'/i, 'accès réseau']
]

const dir = __dirname
const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

describe('connecteurs : aucun secret de compte, aucun réseau', () => {
  it('trouve les sources à vérifier', () => { expect(sources.length).toBeGreaterThan(0) })
  for (const file of sources) {
    it(file, () => {
      const code = readFileSync(join(dir, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const [re, what] of FORBIDDEN) expect(code, `${file} : ${what}`).not.toMatch(re)
    })
  }
})
