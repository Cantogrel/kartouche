import type { DatabaseSync } from 'node:sqlite'
import { isOverrideField, normalizeOverride, resolveView, type BaseView, type EntryOverrides, type EntryView, type OverrideField } from '@shared/overrides'
import { getGame } from '../catalog/catalogStore'

/*
 * Surcouche utilisateur (table `library_overrides`, voir shared/overrides.ts). Ce module est réservé à l'AFFICHAGE : identify, importer,
 * downloads, sources et la fiche du catalogue ne doivent jamais l'importer (test d'invariant dans overrides.test.ts).
 */

/** Surcharges de toutes les entrées (ou de celles demandées), en une seule requête. */
export function loadOverrides(db: DatabaseSync, entryIds?: readonly number[]): Map<number, EntryOverrides> {
  const out = new Map<number, EntryOverrides>()
  const rows = (entryIds
    ? db.prepare(`SELECT entry_id, field, value FROM library_overrides WHERE entry_id IN (${entryIds.map(() => '?').join(',') || 'NULL'})`).all(...entryIds)
    : db.prepare('SELECT entry_id, field, value FROM library_overrides').all()) as { entry_id: number; field: string; value: string }[]
  for (const r of rows) {
    if (!isOverrideField(r.field)) continue // champ inconnu (base d'une version plus récente) : ignoré, jamais supprimé
    const o = out.get(r.entry_id) ?? {}
    o[r.field] = r.value
    out.set(r.entry_id, o)
  }
  return out
}

export const getOverrides = (db: DatabaseSync, entryId: number): EntryOverrides => loadOverrides(db, [entryId]).get(entryId) ?? {}

/**
 * Enregistre une surcharge. Une valeur vide ou invalide rétablit l'origine (même effet que `clearOverride`).
 * Renvoie la valeur enregistrée, ou null si rien n'est surchargé après l'appel. Faux (undefined) si l'entrée ou le champ n'existe pas.
 */
export function setOverride(db: DatabaseSync, entryId: number, field: OverrideField, raw: unknown): string | null | undefined {
  if (!isOverrideField(field) || !db.prepare('SELECT 1 FROM library WHERE id = ?').get(entryId)) return undefined
  const value = normalizeOverride(field, raw)
  if (value === null) { clearOverride(db, entryId, field); return null }
  db.prepare('INSERT INTO library_overrides (entry_id, field, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(entry_id, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(entryId, field, value, Date.now())
  return value
}

export function clearOverride(db: DatabaseSync, entryId: number, field: OverrideField): void {
  db.prepare('DELETE FROM library_overrides WHERE entry_id = ? AND field = ?').run(entryId, field)
}

export function clearAllOverrides(db: DatabaseSync, entryId: number): void {
  db.prepare('DELETE FROM library_overrides WHERE entry_id = ?').run(entryId)
}

/**
 * Données d'origine d'une entrée : titre de la bibliothèque, puis champs de la fiche du catalogue quand le jeu est reconnu.
 * La description n'est pas portée par le catalogue (elle vient de la fiche mise en cache, voir catalog/) : `null` ici, l'appelant
 * qui l'a la passe dans `base`.
 */
export function baseViewOf(db: DatabaseSync, entryId: number, base: Partial<BaseView> = {}): BaseView | null {
  const row = db.prepare('SELECT title, game_id FROM library WHERE id = ?').get(entryId) as { title: string; game_id: number | null } | undefined
  if (!row) return null
  const g = row.game_id !== null ? getGame(db, row.game_id) : null
  return {
    title: base.title ?? row.title,
    description: base.description ?? null,
    genre: base.genre ?? g?.genre ?? null,
    year: base.year ?? g?.year ?? null,
    developer: base.developer ?? g?.developer ?? null
  }
}

/** Vue affichée d'une entrée : valeurs d'origine remplacées champ par champ par celles de l'utilisateur. */
export function getEntryView(db: DatabaseSync, entryId: number, base: Partial<BaseView> = {}): EntryView | null {
  const b = baseViewOf(db, entryId, base)
  return b ? resolveView(b, getOverrides(db, entryId)) : null
}
