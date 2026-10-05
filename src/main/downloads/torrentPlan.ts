import { readFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { ROM_EXTENSIONS } from '@shared/library'
import { archiveVolume } from '../library/archive'
import { baseKeyOfFile } from '../library/content/baseKey'
import { switchContentFromFilename } from '../library/switchContent'

// Quels fichiers d'un torrent Kartouche doit-il réellement demander ? Un torrent peut contenir plusieurs jeux, des notices, des images, des mises à jour,
// des DLC, les pistes d'un disque… La règle suit celle de l'import (library/importer.ts) : on garde ce que l'import sait utiliser pour CE jeu et rien d'autre
// — les fichiers non sélectionnés ne sont jamais téléchargés.

const JUNK = /\.(nfo|txt|md|url|jpe?g|png|gif|bmp|webp|ico|sfv|md5|sha1|sha256|diz|lnk|html?|pdf|rtf|docx?|log|ini|db|bat|cmd|sh|exe|dll|torrent)$/i
const stem = (name: string): string => name.replace(/\.[a-z0-9]{1,6}$/i, '')
const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export interface TorrentFileInfo {
  name: string
  length: number
  /** Chemin dans le torrent (dossiers compris) ; `name` seul si absent. */
  path?: string
}

/**
 * Choisit, dans un torrent multi-fichiers, le fichier qui correspond à l'entrée de source demandée, à partir de ce
 * que la liste déclare déjà (`sizeBytes`, `title`) — jamais « le premier » par défaut. Renvoie l'index, ou `null` si
 * plusieurs fichiers restent aussi plausibles (l'appelant remonte alors une erreur claire plutôt que de deviner).
 */
export function pickTorrentFile(files: TorrentFileInfo[], title: string, sizeBytes: number | null): number | null {
  if (files.length === 1) return 0
  let cand = files.map((_, i) => i)
  const real = cand.filter((i) => !JUNK.test(files[i].name))
  if (real.length) cand = real
  if (cand.length === 1) return cand[0]

  if (sizeBytes) {
    const bySize = cand.filter((i) => files[i].length === sizeBytes)
    if (bySize.length === 1) return bySize[0]
    if (bySize.length > 1) cand = bySize
  }

  const t = norm(title)
  const tTokens = new Set(t.split(' ').filter(Boolean))
  // Sans les parties entre crochets/parenthèses du nom (Title ID, version, région) : « Animal Crossing New Horizons [0100…][v0] » égale alors le titre, alors que
  // « Animal Crossing New Horizons Island Transfer Tool [0100…] » (un autre jeu au nom plus long) ne l'égale pas.
  const bare = (name: string): string => norm(stem(name).replace(/\[[^\]]*\]/g, ' '))
  const tBare = bare(title)
  const score = (i: number): number => {
    const n = norm(stem(files[i].name))
    if (tBare.length >= 3 && bare(files[i].name) === tBare) return 3
    if (n === t) return 3
    if (n.length >= 3 && t.length >= 3 && (` ${n} `.includes(` ${t} `) || ` ${t} `.includes(` ${n} `))) return 2
    const nTokens = new Set(n.split(' ').filter(Boolean))
    const common = [...nTokens].filter((x) => tTokens.has(x)).length
    const union = new Set([...nTokens, ...tTokens]).size
    return union && common / union >= 0.6 ? 1 : 0
  }
  const scored = cand.map((i) => ({ i, s: score(i) })).sort((a, b) => b.s - a.s)
  if (scored[0].s > 0 && scored[0].s > (scored[1]?.s ?? -1)) return scored[0].i
  // Titre ne départage pas : la taille seule peut encore le faire si elle est unique parmi tous les fichiers réels
  return null
}

/** Indices demandés par le paramètre `so=` d'un lien magnet (« 0,2,4-6 »), ou `null` si absent. */
export function parseSelectOnly(input: string | Buffer): number[] | null {
  if (typeof input !== 'string' || !/^magnet:/i.test(input)) return null
  const out: number[] = []
  for (const m of input.matchAll(/[?&]so=([^&#]*)/gi)) {
    for (const part of decodeURIComponent(m[1]).split(',')) {
      const r = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part)
      if (!r) continue
      const a = Number(r[1]), b = r[2] === undefined ? a : Number(r[2])
      for (let i = a; i <= Math.min(b, a + 100_000); i++) out.push(i)
    }
  }
  return out.length ? out : null
}

export interface TorrentPlan {
  /** Fichier principal : le jeu (ou le descripteur du disque). */
  primary: number
  /** Fichiers connus d'avance qui lui appartiennent (volumes d'archive, fichiers du même nom d'une image disque). */
  extras: number[]
  /**
   * Une fois le fichier principal reçu (chemin absolu fourni), fichiers supplémentaires qu'on ne peut connaître qu'en le lisant : pistes référencées par un `.cue`,
   * mises à jour et DLC du jeu dont l'identifiant natif vient d'être lu dans le fichier.
   */
  followUp?: (primaryPath: string) => Promise<number[]>
}

/** Consoles dont les mises à jour/DLC se téléchargent avec le jeu (celles que l'import sait rattacher ET installer : voir library/content/ et emulators/content/). */
const CONTENT_CONSOLES = new Set(['switch', 'n3ds', 'ps3', 'vita', 'wiiu'])
// Wii U : seules les archives .wua de mise à jour/DLC se choisissent par leur nom ; les titres NUS sont des dossiers de plusieurs fichiers (non traités ici : seul le jeu est récupéré).
const CONTENT_EXTS: Record<string, readonly string[]> = { switch: ['nsp', 'xci', 'nsz'], n3ds: ['cia'], ps3: ['pkg'], vita: ['vpk', 'zip'], wiiu: ['wua'] }
/** Fichiers voisins (même nom, autre extension) d'une image de disque. */
const DISC_SIDECARS: Record<string, readonly string[]> = { cue: ['sbi'], ccd: ['img', 'sub', 'sbi'], mds: ['mdf', 'sbi'] }

const UPDATE_WORD = /\b(updates?|patch(es)?)\b/i
const DLC_WORD = /\b(dlcs?|add[- ]?ons?|expansion)\b/i
const posix = (p: string): string => p.replace(/\\/g, '/')
const extOf = (name: string): string => extname(name).slice(1).toLowerCase()

/** Le nom évoque-t-il une mise à jour/un DLC ? Avec, quand le nom porte un Title ID Switch, le jeu parent qu'il désigne (repère le plus fiable du nom). */
function contentHint(name: string, consoleId: string): { kind: 'update' | 'dlc'; baseId?: string } | null {
  const s = stem(name)
  if (consoleId === 'switch') {
    const c = switchContentFromFilename(s)
    if (c && c.kind !== 'base') return { kind: c.kind, baseId: c.baseTitleId || undefined }
    return null
  }
  if (UPDATE_WORD.test(s)) return { kind: 'update' }
  if (DLC_WORD.test(s)) return { kind: 'dlc' }
  return null
}

/**
 * Le nom commence-t-il par le titre demandé (hors régions/langues entre parenthèses) ? Repère faible, jamais utilisé quand un identifiant est disponible : « Game Update v1 »
 * suit « Game », pas « Other Game Update ». S'il se trompe, l'import vérifie l'appartenance dans le fichier même et refuse ; s'il manque un fichier, il s'ajoute à la main
 * depuis la fiche du jeu.
 */
function nameCoversTitle(name: string, title: string): boolean {
  const core = norm(title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' '))
  if (!core) return false
  const n = norm(stem(name))
  return n === core || n.startsWith(`${core} `)
}

/** Pistes d'une feuille .cue (lignes FILE) retrouvées dans le torrent : même dossier que la feuille, nom comparé sans tenir compte de la casse. */
export function cueTrackIndexes(cueText: string, cuePath: string, files: TorrentFileInfo[]): number[] {
  const dir = posix(dirname(posix(cuePath)))
  const refs = [...cueText.matchAll(/^\s*FILE\s+"([^"]+)"/gim)].map((m) => posix(m[1]).toLowerCase())
  const out: number[] = []
  for (const ref of refs) {
    const wanted = (dir === '.' ? ref : `${dir}/${ref}`).toLowerCase()
    const i = files.findIndex((f) => posix(f.path ?? f.name).toLowerCase() === wanted)
    if (i >= 0 && !out.includes(i)) out.push(i)
  }
  return out
}

/**
 * Plan de téléchargement d'un torrent pour une entrée de source : le fichier principal, ses compagnons, et de quoi trouver la suite une fois le principal
 * reçu. `null` si aucun fichier principal ne se détache (plusieurs aussi plausibles : l'appelant le dit, plutôt que de deviner).
 */
export function planTorrent(files: TorrentFileInfo[], title: string, sizeBytes: number | null, consoleId: string | null, only?: number[] | null): TorrentPlan | null {
  if (files.length === 1) return { primary: 0, extras: [] }
  // `so=` du magnet : simple indice pour départager les candidats du fichier principal (jamais pour en demander d'autres que le plan n'autorise).
  const hint = only?.length ? new Set(only) : null
  const narrow = (idx: number[]): number[] => { const k = hint ? idx.filter((i) => hint.has(i)) : []; return k.length ? k : idx }
  const fallback = (): TorrentPlan | null => {
    const cand = narrow(files.map((_, i) => i))
    const p = pickTorrentFile(cand.map((i) => files[i]), title, sizeBytes)
    return p === null ? null : { primary: cand[p], extras: [] }
  }
  if (!consoleId) return fallback()

  const pathOf = (i: number): string => posix(files[i].path ?? files[i].name)
  const real = files.map((_, i) => i).filter((i) => !JUNK.test(files[i].name))
  const romExts = new Set(Object.entries(ROM_EXTENSIONS).filter(([, c]) => c.includes(consoleId)).map(([e]) => e))
  romExts.add('zip')
  if (consoleId === 'switch') romExts.add('nsz') // NSP compressé : l'import le décompresse (library/nsz.ts)
  const isArchive = (i: number): boolean => archiveVolume(files[i].name) !== null
  const firstVolume = (i: number): boolean => archiveVolume(files[i].name)?.isFirst === true
  const contentExts = CONTENT_EXTS[consoleId] ?? []
  const hinted = (i: number): boolean => CONTENT_CONSOLES.has(consoleId) && (contentHint(files[i].name, consoleId) !== null || (consoleId === 'ps3' && extOf(files[i].name) === 'pkg'))

  // Fichiers principaux possibles : un descripteur de disque s'il y en a (les pistes ne sont jamais des candidats : elles suivent le .cue), sinon les ROM et
  // archives de la console (premier volume seulement), sans les mises à jour/DLC reconnaissables.
  const descriptors = real.filter((i) => extOf(files[i].name) in DISC_SIDECARS && romExts.has(extOf(files[i].name)))
  let base = descriptors.length ? descriptors : real.filter((i) => (romExts.has(extOf(files[i].name)) || isArchive(i)) && (!isArchive(i) || firstVolume(i)) && !hinted(i))
  if (!base.length) base = real.filter((i) => (romExts.has(extOf(files[i].name)) || isArchive(i)) && (!isArchive(i) || firstVolume(i)))
  if (!base.length) return fallback()
  base = narrow(base)

  const picked = pickTorrentFile(base.map((i) => files[i]), title, descriptors.length ? null : sizeBytes)
  if (picked === null) return null
  const primary = base[picked]
  const pExt = extOf(files[primary].name)
  const pPath = pathOf(primary)
  const pDir = posix(dirname(pPath))
  const sameStem = (i: number): boolean => posix(dirname(pathOf(i))) === pDir && stem(basename(pathOf(i))).toLowerCase() === stem(basename(pPath)).toLowerCase()

  const extras: number[] = []
  // Volumes d'une archive en plusieurs parties.
  const vol = archiveVolume(files[primary].name)
  if (vol) real.forEach((i) => { if (i !== primary && posix(dirname(pathOf(i))) === pDir && archiveVolume(files[i].name)?.first.toLowerCase() === vol.first.toLowerCase()) extras.push(i) })
  // Fichiers du même nom qui complètent une image de disque (.sbi, .img/.sub d'un .ccd, .mdf d'un .mds).
  const sidecars = DISC_SIDECARS[pExt]
  if (sidecars) real.forEach((i) => { if (i !== primary && sidecars.includes(extOf(files[i].name)) && sameStem(i)) extras.push(i) })

  const plan: TorrentPlan = { primary, extras }
  if (pExt === 'cue') {
    plan.followUp = async (primaryPath) => cueTrackIndexes(await readFile(primaryPath, 'latin1'), pPath, files)
  } else if (CONTENT_CONSOLES.has(consoleId)) {
    const candidates = real.filter((i) => i !== primary && contentExts.includes(extOf(files[i].name)) && hinted(i))
    if (candidates.length) {
      plan.followUp = async (primaryPath) => {
        // Identifiant natif du jeu qu'on vient de télécharger (lu dans le fichier) : c'est lui qui désigne ses mises à jour et DLC.
        let key = await baseKeyOfFile(consoleId, primaryPath, {}).catch(() => null)
        if (!key && consoleId === 'switch') { const n = switchContentFromFilename(stem(basename(primaryPath))); if (n?.kind === 'base' && n.titleId) key = n.titleId }
        return candidates.filter((i) => {
          const hint = contentHint(files[i].name, consoleId)
          if (hint?.baseId && key) return hint.baseId.toUpperCase() === key.toUpperCase() // identifiant dans le nom : exact ou rien
          if (consoleId === 'ps3' && key && files[i].name.toUpperCase().includes(key.toUpperCase())) return true // numéro de série dans le nom du paquet
          return nameCoversTitle(files[i].name, title) // repère faible ; l'import vérifie ensuite l'appartenance dans le fichier même
        })
      }
    }
  }
  return plan
}
