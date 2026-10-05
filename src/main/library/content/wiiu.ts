import { open, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseTmd, parseWiiUTmdContents, TMD_MAX } from './tmd'
import { readWuaTitles } from './wua'
import type { ContentInfo, ContentKind } from './types'

// Contenu Wii U : Title ID 0005xxxx-LLLLLLLL — 00050000 jeu, 0005000E mise à jour, 0005000C DLC, tous trois avec le même identifiant bas.
// Un titre additionnel se présente en DOSSIER : format NUS/WUP (`title.tmd` + `title.tik` + fichiers `.app`, chiffré) ou dossier « loadiine »
// (`meta/meta.xml` + `code/` + `content/`, déjà déchiffré). Seuls les dossiers de mise à jour et de DLC sont traités ici : un dossier de jeu de base
// n'est pas un format que Kartouche importe (ses fichiers restent ignorés comme avant).

const KIND_OF_HIGH: Record<string, ContentKind> = { '00050000': 'base', '0005000E': 'update', '0005000C': 'dlc' }

export function classifyWiiUTitleId(id: string): { kind: ContentKind; baseKey: string } | null {
  const hex = id.toUpperCase()
  if (!/^[0-9A-F]{16}$/.test(hex)) return null
  const kind = KIND_OF_HIGH[hex.slice(0, 8)]
  return kind ? { kind, baseKey: `00050000${hex.slice(8)}` } : null
}

/** `<title_id type="hexBinary" length="8">…</title_id>` et `<title_version type="unsignedInt" length="4">…</title_version>` d'un meta.xml. */
export function parseMetaXml(xml: string): { titleId: string; version: number | null } | null {
  const id = /<title_id[^>]*>\s*([0-9a-fA-F]{16})\s*<\/title_id>/.exec(xml)?.[1]
  if (!id) return null
  const v = /<title_version[^>]*>\s*(\d+)\s*<\/title_version>/.exec(xml)?.[1]
  return { titleId: id.toUpperCase(), version: v === undefined ? null : Number(v) }
}

/** Le dossier est-il un titre Wii U à installer ? null = non (ou jeu de base, hors périmètre) ; sinon ses identifiants. */
export async function probeWiiUFolder(dir: string): Promise<ContentInfo | null> {
  let titleId: string | null = null
  let version: number | null = null
  const names = await readdir(dir).catch(() => [] as string[])
  const tmdName = names.find((n) => n.toLowerCase() === 'title.tmd')
  if (tmdName) {
    const fh = await open(join(dir, tmdName), 'r')
    try {
      const buf = Buffer.alloc(TMD_MAX)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const tmd = parseTmd(buf.subarray(0, bytesRead))
      if (tmd) { titleId = tmd.titleId; version = tmd.version }
    } finally { await fh.close() }
  } else {
    const meta = parseMetaXml(await readFile(join(dir, 'meta', 'meta.xml'), 'latin1').catch(() => ''))
    if (meta) { titleId = meta.titleId; version = meta.version }
  }
  if (!titleId) return null
  const c = classifyWiiUTitleId(titleId)
  const label = basename(dir)
  if (!c) return { console: 'wiiu', kind: 'unknown', titleId, baseKey: '', version: null, source: 'container', label, reason: `type de titre Wii U non pris en charge (${titleId.slice(0, 8)})` }
  if (c.kind === 'base') return null
  return { console: 'wiiu', kind: c.kind, titleId, baseKey: c.baseKey, version: version === null ? null : String(version), source: 'container', label }
}

export type WiiUTitleCheck =
  | { ok: true; format: 'nus' | 'loadiine' | 'wua' }
  | { ok: false; reason: 'ticket' | 'incomplete' | 'invalid'; detail: string }

/**
 * Cemu peut-il réellement ouvrir ce dossier de titre ? Mêmes exigences que son code (Cemu `FST.cpp`, `OpenFromContentFolder`, et `TitleInfo.cpp`, `ParseXmlInfo`) :
 *  - format NUS/WUP (`title.tmd`) : un ticket `title.tik` (sans lui Cemu refuse : `TITLE_TIK_MISSING`) et TOUS les `<id>.app` listés par le TMD ;
 *  - dossier déjà extrait (« loadiine ») : `code/`, `content/`, `meta/` avec `meta/meta.xml`, `code/app.xml` et `code/cos.xml`.
 * Un titre qui ne les remplit pas n'est jamais déclaré à Cemu : il ne serait de toute façon pas listé.
 */
export async function checkWiiUTitle(dir: string): Promise<WiiUTitleCheck> {
  // Archive .wua (un fichier) : lisible si son pied de page ZArchive l'est et qu'elle contient au moins un titre ; Cemu y découvre ses titres lui-même.
  if (/\.wua$/i.test(dir)) return (await readWuaTitles(dir))?.length ? { ok: true, format: 'wua' } : { ok: false, reason: 'invalid', detail: 'archive .wua illisible' }
  const names = await readdir(dir).catch(() => [] as string[])
  const has = (n: string): boolean => names.some((x) => x.toLowerCase() === n.toLowerCase())
  if (has('title.tmd')) {
    const fh = await open(join(dir, names.find((x) => x.toLowerCase() === 'title.tmd')!), 'r')
    let tmd: Buffer
    try { tmd = Buffer.alloc(TMD_MAX); tmd = tmd.subarray(0, (await fh.read(tmd, 0, TMD_MAX, 0)).bytesRead) } finally { await fh.close() }
    const contents = parseWiiUTmdContents(tmd)
    if (!contents) return { ok: false, reason: 'invalid', detail: 'title.tmd illisible' }
    if (!has('title.tik')) return { ok: false, reason: 'ticket', detail: 'title.tik manquant (Cemu en a besoin pour déchiffrer ce titre)' }
    for (const c of contents) {
      const name = `${c.id.toString(16).padStart(8, '0')}.app`
      if (!has(name)) return { ok: false, reason: 'incomplete', detail: `${name} manquant (listé par le TMD)` }
    }
    return { ok: true, format: 'nus' }
  }
  const dirs = new Set(names.map((n) => n.toLowerCase()))
  if (['code', 'content', 'meta'].every((d) => dirs.has(d))) {
    const read = (...p: string[]): Promise<string> => readFile(join(dir, ...p), 'latin1').catch(() => '')
    if (!parseMetaXml(await read('meta', 'meta.xml'))) return { ok: false, reason: 'incomplete', detail: 'meta/meta.xml manquant ou illisible' }
    for (const f of ['app.xml', 'cos.xml']) if (!(await read('code', f))) return { ok: false, reason: 'incomplete', detail: `code/${f} manquant` }
    return { ok: true, format: 'loadiine' }
  }
  return { ok: false, reason: 'invalid', detail: 'ni titre NUS (title.tmd) ni dossier code/content/meta' }
}
