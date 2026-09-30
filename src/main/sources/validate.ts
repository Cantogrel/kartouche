import { SOURCE_LIST_SCHEMA_VERSION, type SourceListDocument } from '@shared/sourceList'
import { consoleById } from '@shared/consoles'

export interface ValidationError {
  path: string
  message: string
}

export type ValidationResult = { ok: true; document: SourceListDocument } | { ok: false; errors: ValidationError[] }

export function validateSourceList(data: unknown): ValidationResult {
  const errors: ValidationError[] = []
  const push = (path: string, message: string): void => void errors.push({ path, message })

  if (typeof data !== 'object' || data === null) {
    push('', 'le document doit être un objet JSON')
    return { ok: false, errors }
  }
  const doc = data as Record<string, unknown>

  if (doc.schemaVersion !== SOURCE_LIST_SCHEMA_VERSION) push('schemaVersion', `attendu ${SOURCE_LIST_SCHEMA_VERSION}, reçu ${JSON.stringify(doc.schemaVersion)}`)
  if (typeof doc.name !== 'string' || !doc.name.trim()) push('name', 'chaîne non vide requise')
  if (doc.homepage !== undefined && typeof doc.homepage !== 'string') push('homepage', 'doit être une chaîne si présent')
  if (doc.generatedAt !== undefined && typeof doc.generatedAt !== 'string') push('generatedAt', 'doit être une chaîne si présent')

  if (!Array.isArray(doc.entries)) {
    push('entries', 'tableau requis')
    return { ok: false, errors }
  }
  doc.entries.forEach((raw, i) => validateEntry(raw, i, push))

  return errors.length ? { ok: false, errors } : { ok: true, document: doc as unknown as SourceListDocument }
}

function validateEntry(raw: unknown, i: number, push: (path: string, message: string) => void): void {
  const p = (field: string): string => `entries[${i}]${field ? '.' + field : ''}`
  if (typeof raw !== 'object' || raw === null) {
    push(p(''), 'doit être un objet')
    return
  }
  const e = raw as Record<string, unknown>

  if (typeof e.title !== 'string' || !e.title.trim()) push(p('title'), 'chaîne non vide requise')
  if (typeof e.console !== 'string' || !consoleById(e.console)) push(p('console'), `console inconnue : ${JSON.stringify(e.console)}`)
  if (!Array.isArray(e.uris) || e.uris.length === 0 || !e.uris.every((u) => typeof u === 'string' && u.length > 0)) {
    push(p('uris'), 'tableau non vide de chaînes requis')
  }
  if (e.sizeBytes !== undefined && (typeof e.sizeBytes !== 'number' || !Number.isInteger(e.sizeBytes) || e.sizeBytes < 0)) {
    push(p('sizeBytes'), 'entier positif requis si présent')
  }
  if (e.note !== undefined && typeof e.note !== 'string') push(p('note'), 'doit être une chaîne si présent')
  if (e.hash !== undefined) {
    if (typeof e.hash !== 'object' || e.hash === null) {
      push(p('hash'), 'doit être un objet si présent')
    } else {
      const h = e.hash as Record<string, unknown>
      if (h.crc32 !== undefined && typeof h.crc32 !== 'string') push(p('hash.crc32'), 'doit être une chaîne si présent')
      if (h.sha1 !== undefined && typeof h.sha1 !== 'string') push(p('hash.sha1'), 'doit être une chaîne si présent')
    }
  }
}
