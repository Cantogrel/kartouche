import type { DatabaseSync } from 'node:sqlite'
import { PC_PLATFORM, parseLaunchSpec, type EntryKind, type GameSource, type LaunchSpec } from '@shared/launch'

/*
 * Entrées non-ROM de la bibliothèque (exécutable ajouté à la main, jeu d'un launcher) : voir shared/launch.ts. Ce module ne fait que les enregistrer et
 * relire leur spécification de lancement ; le lancement lui-même (P05-launch-core) et la lecture des launchers (P06) s'y appuient.
 */

export interface ExternalEntryInput {
  kind: Exclude<EntryKind, 'rom'>
  source: GameSource
  /** Identifiant chez le launcher (appid Steam…) : sert à ne pas dupliquer l'entrée à chaque lecture. Absent pour un exécutable ajouté à la main. */
  nativeId?: string | null
  title: string
  launch: LaunchSpec
}

export type UpsertResult = { ok: true; id: number; created: boolean } | { ok: false; reason: 'invalid' | 'pathTaken' }

/** Valeur de la colonne `path` (unique) : l'exécutable, sinon le dossier d'installation, sinon une adresse propre au launcher. */
const pathOf = (input: ExternalEntryInput, spec: LaunchSpec): string => spec.exe ?? spec.installDir ?? `launcher:${input.source}:${input.nativeId ?? input.title}`

/**
 * Ajoute une entrée non-ROM, ou retrouve celle qui existe déjà : par (source, identifiant natif) pour un jeu de launcher — sa spécification de lancement
 * est alors mise à jour, mais son titre, ses surcharges et son temps de jeu ne bougent pas —, par chemin pour un exécutable ajouté à la main.
 */
export function upsertExternalEntry(db: DatabaseSync, input: ExternalEntryInput): UpsertResult {
  const spec = parseLaunchSpec(input.launch)
  const title = input.title.trim()
  if (!spec || !title || (input.kind === 'exe' && spec.type !== 'exe')) return { ok: false, reason: 'invalid' }
  const path = pathOf(input, spec)
  const launch = JSON.stringify(spec)
  const nativeId = input.nativeId?.trim() || null

  if (nativeId) {
    const existing = db.prepare('SELECT id FROM library WHERE source = ? AND native_id = ?').get(input.source, nativeId) as { id: number } | undefined
    if (existing) {
      const clash = db.prepare('SELECT id FROM library WHERE path = ? AND id <> ?').get(path, existing.id)
      if (clash) return { ok: false, reason: 'pathTaken' }
      db.prepare('UPDATE library SET launch = ?, path = ?, kind = ?, missing = 0 WHERE id = ?').run(launch, path, input.kind, existing.id)
      return { ok: true, id: existing.id, created: false }
    }
  } else {
    const existing = db.prepare("SELECT id FROM library WHERE path = ? AND kind <> 'rom'").get(path) as { id: number } | undefined
    if (existing) return { ok: true, id: existing.id, created: false }
  }
  if (db.prepare('SELECT 1 FROM library WHERE path = ?').get(path)) return { ok: false, reason: 'pathTaken' }
  const id = Number(db.prepare(
    "INSERT INTO library (console, title, path, size, match, missing, added_at, kind, source, native_id, launch) VALUES (?, ?, ?, 0, 'none', 0, ?, ?, ?, ?, ?)"
  ).run(PC_PLATFORM, title, path, Date.now(), input.kind, input.source, nativeId, launch).lastInsertRowid)
  return { ok: true, id, created: true }
}

/** Spécification de lancement d'une entrée non-ROM ; null pour une ROM, une entrée inconnue ou une spécification illisible. */
export function getLaunchSpec(db: DatabaseSync, entryId: number): LaunchSpec | null {
  const row = db.prepare("SELECT launch FROM library WHERE id = ? AND kind <> 'rom'").get(entryId) as { launch: string | null } | undefined
  return row ? parseLaunchSpec(row.launch) : null
}
