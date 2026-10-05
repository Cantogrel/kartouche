import { useEffect, useState, type DragEvent } from 'react'
import { Button } from '@/ui'
import { Modal } from './Modal'
import { confirmDialog } from './AskDialog'
import { t } from '@/i18n'
import { useLibrary } from '@/store/library'
import { usePcMeta } from '@/store/pcMeta'
import { useGameMedia } from './GameMedia'
import { defaultBackgroundId, igdbImageUrl } from '@shared/media'
import type { PcMetaView } from '@shared/pcMeta'
import { baseViewFrom, YEAR_MAX, YEAR_MIN, type BaseView, type EntryOverrides, type OverrideImageField, type OverrideTextField } from '@shared/overrides'

/*
 * Modification d'un jeu de la bibliothèque : titre, description, genre, année, développeur et images. Ce que l'utilisateur change est une surcouche
 * (shared/overrides.ts) : la reconnaissance du jeu, ses téléchargements et sa fiche du catalogue ne bougent pas. Les images s'appliquent tout de suite,
 * les champs texte à l'enregistrement.
 */

const TEXT_FIELDS: readonly OverrideTextField[] = ['title', 'description', 'genre', 'year', 'developer']
const IMAGE_FIELDS: readonly OverrideImageField[] = ['cover', 'icon', 'banner', 'background']
/** Image d'origine (catalogue) qui correspond à chaque image personnelle, pour l'aperçu. */
const ORIGINAL_KIND: Record<OverrideImageField, 'tile' | 'icon' | 'hero'> = { cover: 'tile', icon: 'icon', banner: 'hero', background: 'hero' }

const baseText = (b: BaseView, f: OverrideTextField): string => (f === 'year' ? (b.year === null ? '' : String(b.year)) : (b[f] ?? ''))

export function EditGameDialog({ entryId, onClose }: { entryId: number; onClose: () => void }) {
  const entry = useLibrary((s) => s.entries.find((e) => e.id === entryId))
  const refresh = useLibrary((s) => s.refresh)
  const [ov, setOv] = useState<EntryOverrides | null>(null)
  const [base, setBase] = useState<BaseView | null>(null)
  /** Valeurs tapées et pas encore enregistrées (champ absent = valeur actuelle inchangée). */
  const [edits, setEdits] = useState<Partial<Record<OverrideTextField, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Jeu PC : fiche IGDB trouvée (origine des champs) et titre de la recherche manuelle. */
  const [pc, setPc] = useState<PcMetaView | null>(null)
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  /** Lancement d'un exécutable ajouté (exécutable, arguments, dossier) : enregistré avec le reste. */
  const [launch, setLaunch] = useState<{ exe: string; args: string; cwd: string } | null>(null)
  const gameId = entry?.gameId ?? null
  // Hooks avant le retour anticipé plus bas (sinon React plante au passage « fiche chargée » et tout devient noir).
  // Fond par défaut : une image IGDB du jeu, jamais la bannière (voir defaultBackgroundId).
  const catalogMedia = useGameMedia(gameId)
  const pcMeta = usePcMeta(entry)
  const defaultBg = defaultBackgroundId(entry?.kind === 'rom' ? catalogMedia : pcMeta?.media, entry?.kind !== 'rom')
  const title = entry?.title ?? ''

  useEffect(() => {
    let off = false
    void (async () => {
      const [o, game, pcView] = await Promise.all([window.api.invoke('library:overrides', entryId), gameId !== null ? window.api.invoke('catalog:get', gameId) : Promise.resolve(null), entry?.kind !== undefined && entry.kind !== 'rom' ? window.api.invoke('library:pcMeta', entryId) : Promise.resolve(null)])
      if (off) return
      setOv(o)
      setPc(pcView)
      if (entry?.kind === 'exe') { const l = await window.api.invoke('library:launchSpec', entryId); if (!off && l) setLaunch({ exe: l.exe ?? '', args: l.args ?? '', cwd: l.cwd ?? '' }) }
      setBase(baseViewFrom(game, pcView?.details ?? null, title))
      // La fiche (description, genre de repli…) peut demander du réseau : elle complète les valeurs d'origine quand elle arrive, sans bloquer la fenêtre.
      if (gameId !== null) void window.api.invoke('catalog:details', { id: gameId }).then((d) => { if (!off) setBase(baseViewFrom(game, d, title)) }).catch(() => undefined)
    })()
    return () => { off = true }
  }, [entryId, gameId, title])

  if (!entry || !ov || !base) return null

  const original = (f: OverrideTextField): string => baseText(base, f)
  const value = (f: OverrideTextField): string => edits[f] ?? ov[f] ?? original(f)
  const modified = (f: OverrideTextField): boolean => { const v = value(f).trim(); return v !== '' && v !== original(f) }
  const setText = (f: OverrideTextField, v: string): void => { setError(null); setEdits((e) => ({ ...e, [f]: v })) }

  const identify = async (): Promise<void> => {
    setSearching(true); setError(null)
    try {
      const r = await window.api.invoke('library:identify', { id: entryId, title: search.trim() || undefined })
      setPc(r)
      if (r) setBase(baseViewFrom(null, r.details, title))
      else setError(t('identify.none'))
      await refresh()
    } finally { setSearching(false) }
  }
  const reload = async (): Promise<void> => { setOv(await window.api.invoke('library:overrides', entryId)); await refresh() }
  const resetField = async (f: OverrideTextField | OverrideImageField): Promise<void> => {
    setBusy(true)
    try { setOv(await window.api.invoke('library:clearOverride', { id: entryId, field: f })); setEdits((e) => { const n = { ...e }; delete n[f as OverrideTextField]; return n }); await refresh() } finally { setBusy(false) }
  }
  const resetAll = async (): Promise<void> => {
    if (!(await confirmDialog(t('edit.resetAllConfirm', { title: entry.shownTitle })))) return
    setBusy(true)
    try { setOv(await window.api.invoke('library:resetOverrides', entryId)); setEdits({}); await refresh() } finally { setBusy(false) }
  }
  const setImage = async (field: OverrideImageField, path?: string): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const r = await window.api.invoke('library:setImage', { id: entryId, field, path })
      if (r.ok) await reload()
      else if (r.reason !== 'cancelled') setError(t(`edit.err.${r.reason === 'notImage' || r.reason === 'tooLarge' || r.reason === 'missing' || r.reason === 'unreadable' ? r.reason : 'other'}`))
    } finally { setBusy(false) }
  }
  const drop = (field: OverrideImageField) => (e: DragEvent): void => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) void setImage(field, window.api.pathOf(file))
  }

  const save = async (): Promise<void> => {
    const y = value('year').trim()
    if (y !== '' && (!/^\d{4}$/.test(y) || Number(y) < YEAR_MIN || Number(y) > YEAR_MAX)) { setError(t('edit.yearInvalid', { min: String(YEAR_MIN), max: String(YEAR_MAX) })); return }
    setBusy(true)
    try {
      for (const f of TEXT_FIELDS) {
        if (edits[f] === undefined) continue
        const v = edits[f].trim()
        // Une valeur vide, ou identique à l'origine, n'est pas une modification : l'origine est rétablie.
        if (v === '' || v === original(f)) { if (ov[f] !== undefined) await window.api.invoke('library:clearOverride', { id: entryId, field: f }) }
        else if (v !== ov[f]) await window.api.invoke('library:setOverride', { id: entryId, field: f as OverrideTextField, value: v })
      }
      if (launch && entry.kind === 'exe') {
        const ok = await window.api.invoke('library:setLaunch', { id: entryId, ...launch })
        if (!ok) { setError(t('exe.err.launch')); return }
      }
      await refresh()
      onClose()
    } finally { setBusy(false) }
  }

  const preview = (f: OverrideImageField): string | null => (ov[f] ? `kimg://custom/${ov[f]}`
    : f === 'background' ? (defaultBg ? igdbImageUrl(defaultBg, 't_screenshot_med') : null)
    : gameId !== null ? `kimg://${ORIGINAL_KIND[f]}/${gameId}` : null)
  const anyModified = TEXT_FIELDS.some(modified) || IMAGE_FIELDS.some((f) => ov[f] !== undefined)

  return (
    <Modal title={t('edit.title')} onClose={onClose}>
      <p className="muted edit-hint">{t('edit.hint')}</p>
      <div className="edit-body">
        {TEXT_FIELDS.map((f) => (
          <label key={f} className="field edit-field" style={{ maxWidth: 'none' }}>
            <span className="edit-label">{t(`edit.f.${f}`)}{modified(f) && <span className="edit-badge">{t('edit.modified')}</span>}</span>
            {f === 'description'
              ? <textarea rows={5} value={value(f)} onChange={(e) => setText(f, e.target.value)} />
              : <input value={value(f)} maxLength={f === 'year' ? 4 : 200} inputMode={f === 'year' ? 'numeric' : undefined} onChange={(e) => setText(f, e.target.value)} />}
            {modified(f) && (
              <span className="edit-sub muted">{t('edit.original', { v: original(f) || '—' })} <button type="button" className="edit-link" disabled={busy} onClick={() => void resetField(f)}>{t('edit.reset')}</button></span>
            )}
          </label>
        ))}
        {entry.kind !== 'rom' && (
          <div className="field edit-field" style={{ maxWidth: 'none' }}>
            <span className="edit-label">{t('identify.title')}</span>
            <span className="muted">{pc ? t('identify.found', { name: pc.name }) : t('identify.notFound')}</span>
            <div className="row"><input value={search} placeholder={title} onChange={(e) => setSearch(e.target.value)} /><Button disabled={searching} onClick={() => void identify()}>{searching ? t('identify.searching') : t('identify.search')}</Button></div>
          </div>
        )}
        {launch && (
          <>
            <h3 className="edit-section">{t('exe.launch')}</h3>
            <label className="field edit-field" style={{ maxWidth: 'none' }}><span className="edit-label">{t('exe.f.exe')}</span>
              <input value={launch.exe} onChange={(e) => setLaunch({ ...launch, exe: e.target.value })} /></label>
            <label className="field edit-field" style={{ maxWidth: 'none' }}><span className="edit-label">{t('exe.f.args')}</span>
              <input value={launch.args} maxLength={2000} onChange={(e) => setLaunch({ ...launch, args: e.target.value })} /></label>
            <label className="field edit-field" style={{ maxWidth: 'none' }}><span className="edit-label">{t('exe.f.cwd')}</span>
              <input value={launch.cwd} placeholder={t('exe.cwdHint')} onChange={(e) => setLaunch({ ...launch, cwd: e.target.value })} /></label>
          </>
        )}
        <h3 className="edit-section">{t('edit.images')}</h3>
        {IMAGE_FIELDS.map((f) => (
          <div key={f} className="edit-image" onDragOver={(e) => e.preventDefault()} onDrop={drop(f)}>
            <span className="edit-thumb" aria-hidden>{preview(f) && <img key={preview(f)!} src={preview(f)!} alt="" />}</span>
            <div className="edit-image-body">
              <strong>{t(`edit.f.${f}`)}{ov[f] !== undefined && <span className="edit-badge">{t('edit.modified')}</span>}</strong>
              <div className="row">
                <Button disabled={busy} onClick={() => void setImage(f)}>{t('edit.choose')}</Button>
                {ov[f] !== undefined && <Button disabled={busy} onClick={() => void resetField(f)}>{t('edit.reset')}</Button>}
              </div>
              <span className="muted">{t('edit.dropHint')}</span>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="edit-error" role="alert">{error}</p>}
      <div className="row modal-actions">
        <Button variant="danger" disabled={busy || !anyModified} onClick={() => void resetAll()}>{t('edit.resetAll')}</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{t('edit.save')}</Button>
      </div>
    </Modal>
  )
}
