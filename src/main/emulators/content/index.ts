import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { InstallOutcome } from '../../library/content/types'
import { getRow } from '../emulatorStore'
import { azaharInstaller } from './azahar'
import { overlaps } from './snapshot'
import { cemuInstaller } from './cemu'
import { edenInstaller } from './eden'
import { processRunning } from './process'
import { rpcs3Installer } from './rpcs3'
import type { ContentInstaller, ContentRef, GameRef, InstallEnv, UninstallOutcome, UninstallRef } from './types'
import { vita3kInstaller } from './vita3k'

/** Une stratégie par console qui a une notion de mise à jour/DLC (voir l'audit dans le CHANGELOG) ; les autres consoles n'en ont pas. */
const INSTALLERS: Record<string, ContentInstaller> = { switch: edenInstaller, n3ds: azaharInstaller, ps3: rpcs3Installer, wiiu: cemuInstaller, vita: vita3kInstaller }

export const installerFor = (console: string): ContentInstaller | undefined => INSTALLERS[console]

interface Row {
  id: number; kind: string; path: string; title_id: string | null; version: string | null; needs: string | null
}

/**
 * Installe (rend visibles de l'émulateur) les contenus d'un jeu qui ne le sont pas encore ; sans effet sur ceux déjà installés, hormis la vérification
 * idempotente des installateurs « gérés » au lancement. Un échec laisse le contenu `failed`/`pending` : il sera retenté au lancement suivant.
 * `install` est injectable pour les tests.
 */
export async function installPendingContent(
  db: DatabaseSync, libraryId: number, romsDir: string, when: 'import' | 'launch',
  deps: { env?: Partial<InstallEnv>; installers?: Record<string, ContentInstaller> } = {}
): Promise<void> {
  const game = db.prepare('SELECT id, console, title, path, title_id FROM library WHERE id = ?').get(libraryId) as
    { id: number; console: string; title: string; path: string; title_id: string | null } | undefined
  const installer = game && (deps.installers ?? INSTALLERS)[game.console]
  if (!game || !installer) return
  const rows = db.prepare('SELECT id, kind, path, title_id, version, needs, state FROM library_content WHERE library_id = ? ORDER BY CASE kind WHEN \'update\' THEN 0 ELSE 1 END, id').all(libraryId) as unknown as (Row & { state: string })[]
  const todo = rows.filter((r) => r.state !== 'installed' || (when === 'launch' && installer.managed))
  if (!todo.length) return
  const row = getRow(db, installer.emulatorId)
  const env: InstallEnv = { romsDir, emulator: row && existsSync(row.exe) ? { dir: row.dir, exe: row.exe } : null, isRunning: processRunning, ...deps.env }
  const gameRef: GameRef = { id: game.id, console: game.console, title: game.title, path: game.path, baseKey: game.title_id ?? '' }
  for (const r of todo) {
    const item: ContentRef = { id: r.id, kind: r.kind as 'update' | 'dlc', path: r.path, titleId: r.title_id, version: r.version, needs: r.needs }
    const outcome: InstallOutcome = await installer.install(env, item, gameRef, when).catch((e: unknown) => ({ state: 'failed' as const, reason: 'error' as const, detail: e instanceof Error ? e.message : String(e) }))
    if (outcome.state === r.state && r.state === 'installed') continue
    db.prepare('UPDATE library_content SET state = ?, reason = ?, detail = ?, installed_at = ?, emu_files = COALESCE(?, emu_files), emu_backup = COALESCE(?, emu_backup) WHERE id = ?')
      .run(outcome.state, outcome.reason ?? null, outcome.detail ?? null, outcome.state === 'installed' ? Date.now() : null, outcome.emuFiles ? JSON.stringify(outcome.emuFiles) : null, outcome.emuBackups ? JSON.stringify(outcome.emuBackups) : null, r.id)
  }
}

/**
 * Sépare ce qu'un contenu peut retirer de ce qu'il partage avec d'autres. Un fichier ou dossier qui en recouvre un autre (même chemin, ou l'un dans l'autre) est partagé ; un DOSSIER
 * qui contient seulement les fichiers d'un autre contenu est examiné élément par élément, pour que ses propres fichiers partent quand même sans toucher à ceux de l'autre.
 */
export async function splitShared(owned: readonly string[], others: readonly string[]): Promise<{ free: string[]; kept: string[] }> {
  const free: string[] = []
  const kept: string[] = []
  const visit = async (p: string): Promise<void> => {
    if (!others.some((q) => overlaps(p, q))) { free.push(p); return }
    const insideOther = others.some((q) => resolve(q).toLowerCase().startsWith(resolve(p).toLowerCase() + sep))
    const equalOrUnder = others.some((q) => { const x = resolve(p).toLowerCase(), y = resolve(q).toLowerCase(); return x === y || x.startsWith(y + sep) })
    if (insideOther && !equalOrUnder && (await stat(p).catch(() => null))?.isDirectory()) {
      for (const child of await readdir(p).catch(() => [] as string[])) await visit(join(p, child))
      kept.push(p) // le dossier lui-même reste : il porte les fichiers de l'autre contenu
      return
    }
    kept.push(p)
  }
  for (const p of owned) await visit(p)
  return { free, kept }
}

export interface UninstallResult { ok: boolean; error?: string; /** Reste côté émulateur, à dire à l'utilisateur. */ leftover?: string }

/**
 * Désinstalle UN contenu : le retire de l'émulateur (ce que son installateur y a mis), supprime le fichier rangé par RomVault (jamais un fichier laissé là où
 * l'utilisateur l'avait mis : seulement ce qui est sous `romsDir`), puis oublie la ligne. Si l'émulateur refuse (ouvert…), rien n'est supprimé.
 * `deps` est injectable pour les tests.
 */
export async function uninstallContent(
  db: DatabaseSync, contentId: number, romsDir: string,
  deps: { env?: Partial<InstallEnv>; installers?: Record<string, ContentInstaller> } = {}
): Promise<UninstallResult> {
  const c = db.prepare('SELECT id, library_id, kind, path, title_id, version, needs, state, emu_files, installed_at, emu_backup FROM library_content WHERE id = ?').get(contentId) as
    { id: number; library_id: number; kind: string; path: string; title_id: string | null; version: string | null; needs: string | null; state: string; emu_files: string | null; installed_at: number | null; emu_backup: string | null } | undefined
  if (!c) return { ok: false, error: 'contenu introuvable' }
  const game = db.prepare('SELECT id, console, title, path, title_id FROM library WHERE id = ?').get(c.library_id) as
    { id: number; console: string; title: string; path: string; title_id: string | null } | undefined
  const installer = game && (deps.installers ?? INSTALLERS)[game.console]
  let leftover: string | undefined
  if (game && installer?.uninstall && (c.state === 'installed' || c.emu_files)) {
    const row = getRow(db, installer.emulatorId)
    const env: InstallEnv = { romsDir, emulator: row && existsSync(row.exe) ? { dir: row.dir, exe: row.exe } : null, isRunning: processRunning, ...deps.env }
    const owned = c.emu_files ? JSON.parse(c.emu_files) as string[] : null
    // Un fichier que RomVault a écrit pour CE contenu mais que d'autres contenus (même jeu ou non) ont écrit aussi — mise à jour qui en remplace une autre, DLC rangés dans un même
    // dossier — n'est retiré qu'avec son DERNIER propriétaire : retiré maintenant, il casserait les autres. Détecté AVANT toute suppression.
    const others = (db.prepare('SELECT emu_files FROM library_content WHERE id <> ? AND emu_files IS NOT NULL').all(c.id) as { emu_files: string }[]).flatMap((o) => JSON.parse(o.emu_files) as string[])
    const { free, kept: sharedKept } = owned ? await splitShared(owned, others) : { free: null, kept: [] as string[] }
    const siblings = (db.prepare("SELECT id, kind, path, title_id, version, needs, installed_at FROM library_content WHERE library_id = ? AND id <> ? AND state = 'installed'").all(c.library_id, c.id) as unknown as (Row & { installed_at: number | null })[])
      .map((r): ContentRef => ({ id: r.id, kind: r.kind as 'update' | 'dlc', path: r.path, titleId: r.title_id, version: r.version, needs: r.needs, installedAt: r.installed_at }))
    const ref: UninstallRef = { id: c.id, kind: c.kind as 'update' | 'dlc', path: c.path, titleId: c.title_id, version: c.version, needs: c.needs, installedAt: c.installed_at, siblings, emuFiles: free, emuBackups: c.emu_backup ? JSON.parse(c.emu_backup) as Record<string, string> : null }
    const gameRef: GameRef = { id: game.id, console: game.console, title: game.title, path: game.path, baseKey: game.title_id ?? '' }
    const out: UninstallOutcome = (await installer.uninstall(env, [ref], gameRef).catch((e: unknown): UninstallOutcome => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }))) ?? { ok: true }
    if (!out.ok) return { ok: false, error: out.detail ?? 'désinstallation refusée par l’émulateur' }
    leftover = out.leftover
    if (sharedKept.length) leftover = [leftover, `fichiers partagés avec un autre contenu conservés (${sharedKept.length})`].filter(Boolean).join(' ; ')
    // Un chemin retiré peut avoir porté d'autres contenus du même jeu (une mise à jour qui en recouvrait une autre, un DLC rangé dans le même dossier) : ils
    // repassent en attente et sont réinstallés au prochain lancement, plutôt que de rester annoncés « installés » alors que leurs fichiers ont disparu.
    if (out.removed?.length) {
      const inside = (f: string, d: string): boolean => { const a = resolve(f).toLowerCase(), b = resolve(d).toLowerCase(); return a === b || a.startsWith(b + sep) }
      const sibs = db.prepare("SELECT id, kind, emu_files FROM library_content WHERE library_id = ? AND id <> ? AND state = 'installed'").all(c.library_id, c.id) as { id: number; kind: string; emu_files: string | null }[]
      for (const s of sibs) {
        const files = s.emu_files ? JSON.parse(s.emu_files) as string[] : []
        if (files.some((f) => out.removed!.some((d) => inside(f, d))))
          db.prepare("UPDATE library_content SET state = 'pending', reason = 'onLaunch', detail = NULL, installed_at = NULL, emu_files = NULL WHERE id = ?").run(s.id)
      }
    }
  }
  // Seul le rangement de RomVault est supprimé ; un fichier laissé en place par l'utilisateur (mode « ne pas copier ») lui appartient.
  const inRoms = resolve(c.path).toLowerCase().startsWith(resolve(romsDir).toLowerCase() + sep)
  if (inRoms) {
    await rm(c.path, { recursive: true, force: true }).catch(() => undefined)
    await rm(`${c.path}.zrif`, { force: true }).catch(() => undefined) // zRIF fourni par l'utilisateur, copié à côté du paquet Vita rangé
    await rmdir(dirname(c.path)).catch(() => undefined) // dossier du jeu : seulement s'il est devenu vide (rmdir refuse un dossier non vide)
  }
  db.prepare('DELETE FROM library_content WHERE id = ?').run(c.id)
  return { ok: true, leftover }
}
