import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Button } from '@/ui'
import { t } from '@/i18n'
import { useLibrary } from '@/store/library'
import { platformLabel } from '@shared/consoles'

type Dialog =
  /** Création (collectionId = null) ou modification d'une collection : nom + jeux. */
  | { kind: 'editor'; collectionId: number | null }
  /** Choix des collections d'un jeu. */
  | { kind: 'picker'; entryId: number }

interface DialogState { dialog: Dialog | null; open: (d: Dialog) => void; close: () => void }
export const useDialog = create<DialogState>((set) => ({ dialog: null, open: (dialog) => set({ dialog }), close: () => set({ dialog: null }) }))

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const box = useRef<HTMLDivElement>(null)
  // Le focus entre dans la fenetre (premier champ, sinon la fenetre elle-meme) et revient au declencheur a la fermeture.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ;(box.current?.querySelector<HTMLElement>('input, button') ?? box.current)?.focus()
    return () => before?.focus?.()
  }, [])
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** Fenêtres partagées (rendues une fois, dans App). */
export function Dialogs() {
  const { dialog, close } = useDialog()
  if (!dialog) return null
  return dialog.kind === 'editor' ? <CollectionEditor collectionId={dialog.collectionId} onClose={close} /> : <CollectionPicker entryId={dialog.entryId} onClose={close} />
}

function CollectionEditor({ collectionId, onClose }: { collectionId: number | null; onClose: () => void }) {
  const { entries, collections, createCollection, renameCollection, setMembers } = useLibrary()
  const current = collections.find((c) => c.id === collectionId)
  const [name, setName] = useState(current?.name ?? '')
  const [selected, setSelected] = useState<Set<number>>(() => new Set(entries.filter((e) => collectionId !== null && e.collections.includes(collectionId)).map((e) => e.id)))
  const [filter, setFilter] = useState('')
  const [taken, setTaken] = useState(false)
  const q = filter.trim().toLowerCase()
  const shown = useMemo(() => entries.filter((e) => !q || e.title.toLowerCase().includes(q)), [entries, q])
  const toggle = (id: number): void => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const save = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    const clash = collections.some((c) => c.id !== collectionId && c.name.toLowerCase() === n.toLowerCase())
    if (clash) { setTaken(true); return }
    let id = collectionId
    if (id === null) id = await createCollection(n)
    else if (n !== current?.name) await renameCollection(id, n)
    if (id !== null) await setMembers(id, [...selected])
    onClose()
  }
  return (
    <Modal title={t(collectionId === null ? 'collection.newTitle' : 'collection.editTitle')} onClose={onClose}>
      <label className="field" style={{ maxWidth: 'none' }}>{t('collection.name')}
        <input autoFocus value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setTaken(false) }} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} />
        {taken && <span className="muted" style={{ color: '#ff7b7b' }}>{t('collection.taken')}</span>}
      </label>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{t('collection.games')}</strong><span className="muted">{t('collection.selected', { n: selected.size })}</span>
      </div>
      <input className="modal-filter" placeholder={t('collection.filterGames')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="modal-list">
        {shown.map((e) => (
          <label key={e.id} className="check modal-item">
            <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} /> <span className="modal-title">{e.title}</span> <span className="muted">{platformLabel(e.console)}</span>
          </label>
        ))}
        {shown.length === 0 && <p className="muted">{t('library.noMatch')}</p>}
      </div>
      <div className="row modal-actions">
        <Button onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>{t('collection.save')}</Button>
      </div>
    </Modal>
  )
}

/** Cases à cocher : chaque clic s'applique tout de suite. Une nouvelle collection peut être créée à la volée (et le jeu y est ajouté). */
function CollectionPicker({ entryId, onClose }: { entryId: number; onClose: () => void }) {
  const entry = useLibrary((s) => s.entries.find((e) => e.id === entryId))
  const { collections, createCollection, setMember } = useLibrary()
  const [name, setName] = useState('')
  const [taken, setTaken] = useState(false)
  if (!entry) return null
  const add = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    if (collections.some((c) => c.name.toLowerCase() === n.toLowerCase())) { setTaken(true); return }
    const id = await createCollection(n)
    if (id !== null) await setMember(id, entry.id, true)
    setName('')
  }
  return (
    <Modal title={t('collection.pickTitle')} onClose={onClose}>
      <div className="muted modal-title">{entry.title}</div>
      <div className="modal-list">
        {collections.length === 0 && <p className="muted">{t('collection.none')}</p>}
        {collections.map((c) => (
          <label key={c.id} className="check modal-item">
            <input type="checkbox" checked={entry.collections.includes(c.id)} onChange={(e) => void setMember(c.id, entry.id, e.target.checked)} /> <span className="modal-title">{c.name}</span> <span className="muted">{c.count}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <input className="modal-filter" style={{ flex: 1, margin: 0 }} placeholder={t('collection.newInline')} value={name} maxLength={60}
          onChange={(e) => { setName(e.target.value); setTaken(false) }} onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
        <Button disabled={!name.trim()} onClick={() => void add()}>{t('collection.createAdd')}</Button>
      </div>
      {taken && <span className="muted" style={{ color: '#ff7b7b' }}>{t('collection.taken')}</span>}
      <div className="row modal-actions"><Button variant="primary" onClick={onClose}>{t('dialog.close')}</Button></div>
    </Modal>
  )
}
