import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isLangCode, parseLangFile, type LangFile, type LangParse } from '../../shared/lang'

/** Fichiers de langue ajoutés par l'utilisateur : `<data>/languages/<code>.json` (jamais écrasés par une mise à jour de l'app). */
export const languagesDir = (dataDir: string): string => join(dataDir, 'languages')

export async function listUserLanguages(dataDir: string): Promise<LangFile[]> {
  let names: string[]
  try { names = await readdir(languagesDir(dataDir)) } catch { return [] }
  const out: LangFile[] = []
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue
    try {
      const r = parseLangFile(await readFile(join(languagesDir(dataDir), n), 'utf8'))
      if (r.ok && n === `${r.file.code}.json`) out.push(r.file)
    } catch { /* fichier illisible : ignoré */ }
  }
  return out
}

/** Valide le fichier choisi puis le copie dans le dossier des langues (remplace une version précédente du même code). */
export async function importUserLanguage(dataDir: string, sourcePath: string): Promise<LangParse> {
  let text: string
  try { text = await readFile(sourcePath, 'utf8') } catch { return { ok: false, error: 'json' } }
  const r = parseLangFile(text)
  if (!r.ok) return r
  await mkdir(languagesDir(dataDir), { recursive: true })
  await writeFile(join(languagesDir(dataDir), `${r.file.code}.json`), JSON.stringify({ format: 'kartouche.lang/v1', ...r.file }, null, 2))
  return r
}

export async function removeUserLanguage(dataDir: string, code: string): Promise<boolean> {
  if (!isLangCode(code)) return false
  await rm(join(languagesDir(dataDir), `${code}.json`), { force: true })
  return true
}
