import { useEffect, useState } from 'react'
import { Button } from '@/ui'
import { Modal } from './Modal'
import { t } from '@/i18n'
import { useLibrary } from '@/store/library'
import { useCustomEmulators, useEntryEmulators } from '@/store/customEmulators'
import { playEntry } from './PlayButton'
import { useDialog } from './CollectionDialogs'
import type { LibraryEntry } from '@shared/library'

/** Bouton « Émulateur… » à côté de Jouer : seulement pour une ROM que plusieurs émulateurs savent lancer (il faut au moins un émulateur personnalisé). */
export function PlayWithButton({ entry }: { entry: LibraryEntry }) {
  const info = useEntryEmulators(entry)
  if (!info || info.options.length < 2) return null
  return <Button onClick={() => useDialog.getState().open({ kind: 'playWith', entryId: entry.id })}>{t('play.with')}</Button>
}

/** Choix de l'émulateur d'UN jeu : défaut de sa console, ou l'un de ceux qui savent le lancer. Le choix est retenu pour ce jeu. */
export function PlayWithDialog({ entryId, onClose }: { entryId: number; onClose: () => void }) {
  const entry = useLibrary((s) => s.entries.find((e) => e.id === entryId))
  const customs = useCustomEmulators((s) => s.list)
  const refreshLibrary = useLibrary((s) => s.refresh)
  const [info, setInfo] = useState<Awaited<ReturnType<typeof loadOptions>> | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let off = false
    void loadOptions(entryId).then((i) => { if (!off) { setInfo(i); setSel(i.chosen) } })
    return () => { off = true }
  }, [entryId])
  if (!entry || !info) return null
  const name = (id: string | null): string => info.options.find((o) => o.id === id)?.name ?? ''
  const missing = (id: string | null): boolean => !!id && !!customs.find((c) => c.id === id)?.missing
  const defaultName = name(info.consoleDefault ?? builtinOf(info))
  const apply = async (): Promise<boolean> => {
    setBusy(true)
    try {
      const ok = await window.api.invoke('emulators:choose', { entryId, emulatorId: sel })
      await refreshLibrary()
      return ok
    } finally { setBusy(false) }
  }
  return (
    <Modal title={t('playWith.title')} onClose={onClose}>
      <p className="muted">{entry.shownTitle}</p>
      <div className="playwith-list" role="radiogroup" aria-label={t('playWith.title')}>
        <label className="check modal-item">
          <input type="radio" name="emu" checked={sel === null} onChange={() => setSel(null)} />
          <span className="modal-title">{t('playWith.default', { name: defaultName })}</span>
        </label>
        {info.options.map((o) => (
          <label key={o.id} className="check modal-item">
            <input type="radio" name="emu" checked={sel === o.id} onChange={() => setSel(o.id)} disabled={missing(o.id)} />
            <span className="modal-title">{o.name}</span>
            <span className="muted">{o.kind === 'custom' ? (missing(o.id) ? t('emu.custom.missing') : t('emu.custom')) : ''}</span>
          </label>
        ))}
      </div>
      <p className="muted">{t('playWith.hint')}</p>
      <div className="row modal-actions">
        <Button onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button disabled={busy} onClick={async () => { if (await apply()) onClose() }}>{t('playWith.use')}</Button>
        <Button variant="primary" disabled={busy || entry.missing} onClick={async () => { if (await apply()) { onClose(); void playEntry({ ...entry, emulatorId: sel }) } }}>{`▶ ${t('play')}`}</Button>
      </div>
    </Modal>
  )
}

const loadOptions = (entryId: number): Promise<{ options: { id: string; name: string; kind: 'builtin' | 'custom' }[]; chosen: string | null; consoleDefault: string | null; effective: string | null }> =>
  window.api.invoke('emulators:options', entryId)

/** Émulateur intégré de la console parmi les options (premier de la liste : l'intégré passe avant les personnalisés). */
const builtinOf = (info: { options: { id: string; kind: 'builtin' | 'custom' }[] }): string | null => info.options.find((o) => o.kind === 'builtin')?.id ?? null
