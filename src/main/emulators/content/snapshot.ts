import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

// Suivi exact de ce qu'une installation écrit dans l'espace d'un émulateur : photographie des dossiers concernés avant, puis après, et différence. Seul ce qui est NOUVEAU
// est « à Kartouche » : un fichier déjà là (installé à la main, par un autre outil, ou par un autre contenu) n'est jamais compté, même si l'installation l'a réécrit.

export interface TreeSnapshot {
  /** Clé (chemin en minuscules) → chemin réel et « taille:date de modification » de chaque fichier. */
  files: Map<string, { path: string; sig: string }>
  /** Clé → chemin réel de chaque dossier rencontré (racines comprises). */
  dirs: Map<string, string>
  /** Racines (clés) qui existaient au moment de la photographie. */
  roots: Set<string>
}

const key = (p: string): string => resolve(p).toLowerCase()

async function walk(dir: string, snap: TreeSnapshot): Promise<void> {
  snap.dirs.set(key(dir), resolve(dir))
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, snap)
    else {
      const st = await stat(p).catch(() => null)
      if (st) snap.files.set(key(p), { path: resolve(p), sig: `${st.size}:${Math.round(st.mtimeMs)}` })
    }
  }
}

/** Photographie des dossiers `roots` (récursive) ; un dossier absent est simplement noté absent. */
export async function snapshotTrees(roots: readonly string[]): Promise<TreeSnapshot> {
  const snap: TreeSnapshot = { files: new Map(), dirs: new Map(), roots: new Set() }
  for (const r of roots) {
    if ((await stat(r).catch(() => null))?.isDirectory()) { snap.roots.add(key(r)); await walk(r, snap) }
  }
  return snap
}

const inside = (child: string, parent: string): boolean => child.startsWith(parent + sep)

export interface TreeDiff {
  /** Ce que l'installation a CRÉÉ : une racine entière si elle n'existait pas, sinon dossiers nouveaux (le plus haut seulement) et fichiers nouveaux. Chemins absolus. */
  created: string[]
  /** Fichiers qui existaient déjà et que l'installation a réécrits : jamais comptés comme appartenant à Kartouche. */
  modified: string[]
}

/** Différence entre la photographie `before` et l'état actuel des mêmes `roots`. */
export async function diffTrees(before: TreeSnapshot, roots: readonly string[]): Promise<TreeDiff> {
  const after = await snapshotTrees(roots)
  const created: string[] = []
  const modified: string[] = []
  // Racines entières nouvelles (chaque racine est le dossier propre d'un contenu : jamais un parent partagé).
  const newRoots: string[] = []
  for (const r of roots) if (!before.roots.has(key(r)) && after.roots.has(key(r))) { created.push(resolve(r)); newRoots.push(key(r)) }
  const underNewRoot = (k: string): boolean => newRoots.some((n) => k === n || inside(k, n))
  // Dossiers nouveaux (le plus haut seulement) dans les racines qui existaient déjà.
  const newDirs = [...after.dirs].filter(([k]) => !before.dirs.has(k) && !underNewRoot(k)).sort((a, b) => a[0].length - b[0].length)
  const topDirs: string[] = []
  for (const [k, p] of newDirs) if (!topDirs.some((t) => inside(k, t))) { topDirs.push(k); created.push(p) }
  for (const [k, f] of after.files) {
    if (underNewRoot(k) || topDirs.some((t) => inside(k, t))) continue
    const prev = before.files.get(k)
    if (!prev) created.push(f.path)
    else if (prev.sig !== f.sig) modified.push(f.path)
  }
  return { created, modified }
}

/** `a` et `b` se recouvrent-ils (même chemin, ou l'un dans l'autre) ? */
export function overlaps(a: string, b: string): boolean {
  const x = key(a), y = key(b)
  return x === y || inside(x, y) || inside(y, x)
}

/**
 * Une racine « conteneur » (dossier d'un titre, dossier de tickets) créée par l'installation est remplacée par son CONTENU : on ne possède pas le conteneur lui-même, car il peut
 * recevoir plus tard autre chose (une sauvegarde, le ticket d'un autre contenu). Le conteneur n'est retiré que s'il est devenu vide (`rmdir`).
 */
export async function expandCreatedRoots(created: readonly string[], roots: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const c of created) {
    if (roots.some((r) => key(r) === key(c))) for (const e of await readdir(c).catch(() => [] as string[])) out.push(join(c, e))
    else out.push(c)
  }
  return out
}

/**
 * Sauvegarde, hors de l'espace de l'émulateur, de chaque fichier de `targets` qui existe (l'installation s'apprête à l'écraser). Renvoie cible → copie, copie rangée sous `backupRoot`
 * à la même position relative que la cible sous `baseDir`. Un dossier de sauvegarde antérieur du même contenu est d'abord vidé.
 */
export async function backupFiles(targets: readonly string[], baseDir: string, backupRoot: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await rm(backupRoot, { recursive: true, force: true })
  for (const target of targets) {
    if (!(await stat(target).catch(() => null))?.isFile()) continue
    const copy = join(backupRoot, relative(baseDir, target))
    await mkdir(dirname(copy), { recursive: true })
    await copyFile(target, copy)
    out[target] = copy
  }
  return out
}
