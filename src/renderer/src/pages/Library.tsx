import { useEffect, useState, type DragEvent } from 'react'
import { Button, Pill } from '@/ui'
import { EntryCard } from '@/ui/EntryCard'
import { useDialog } from '@/ui/CollectionDialogs'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import { onEntryContext } from '@/ui/EntryMenu'
import type { ImportItem } from '@shared/library'

/** Onglet : un filtre fixe ou `c<id>` pour une collection. */
type Tab = 'all' | 'ready' | 'missing' | 'favorites' | `c${number}`

const itemLabel = (i: ImportItem): string => t(`import.${i.status}`)

export function Library() {
  const { librarySearch } = useApp()
  const { entries, collections, loaded, busy, progress, result, refresh, importPaths, scan, dismissResult, deleteCollection } = useLibrary()
  const hasScanFolders = useSettings((s) => s.settings.scanFolders.length > 0)
  const [tab, setTab] = useState<Tab>('all')
  const [over, setOver] = useState(false)
  const [menu, setMenu] = useState(false)
  const openDialog = useDialog((s) => s.open)
  // Le menu d'ajout se referme au clic ailleurs ou sur Échap.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(false)
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(false) }
    window.addEventListener('click', close); window.addEventListener('keydown', key)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key) }
  }, [menu])
  useEffect(() => { void refresh() }, [refresh])

  const q = librarySearch.trim().toLowerCase()
  const collectionId = tab.startsWith('c') ? Number(tab.slice(1)) : null
  // Une collection supprimée ailleurs (ou renommée) ne doit pas laisser un onglet fantôme.
  useEffect(() => { if (collectionId !== null && loaded && !collections.some((c) => c.id === collectionId)) setTab('all') }, [collectionId, collections, loaded])
  const games = entries
    .filter((g) => (tab === 'ready' ? !g.missing : tab === 'missing' ? g.missing : tab === 'favorites' ? g.favorite : collectionId !== null ? g.collections.includes(collectionId) : true))
    .filter((g) => !q || g.title.toLowerCase().includes(q))
  const pick = async (kind: 'files' | 'folder'): Promise<void> => { setMenu(false); await importPaths(await window.api.invoke('library:pick', kind)) }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault(); setOver(false)
    void importPaths([...e.dataTransfer.files].map((f) => window.api.pathOf(f)).filter(Boolean))
  }
  const current = collectionId !== null ? collections.find((c) => c.id === collectionId) : undefined
  const counts = result ? (['added', 'duplicate', 'ambiguous', 'error'] as const).map((k) => [k, result.items.filter((i) => i.status === k).length] as const).filter(([, n]) => n > 0) : []

  return (
    <div className={`content dropzone${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false) }} onDrop={onDrop}>
      <div className="toolbar">
        <div className="row">
          {(['all', 'ready', 'missing', 'favorites'] as Tab[]).map((k) => <Pill key={k} active={tab === k} onClick={() => setTab(k)}>{k === 'favorites' ? '♥ ' : ''}{t(`tab.${k}`)}</Pill>)}
          {collections.length > 0 && (
            <select className={`collection-select${current ? ' active' : ''}`} value={collectionId ?? ''} aria-label={t('nav.collections')}
              onChange={(e) => setTab(e.target.value ? (`c${e.target.value}` as Tab) : 'all')}>
              <option value="">{t('collection.select')}</option>
              {collections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
            </select>
          )}
          <Pill onClick={() => openDialog({ kind: 'editor', collectionId: null })}>{t('collection.new')}</Pill>
        </div>
        <div className="row">
          {current && <>
            <Button onClick={() => openDialog({ kind: 'editor', collectionId: current.id })}>{t('collection.edit')}</Button>
            <Button onClick={() => { if (window.confirm(t('collection.confirmDelete', { name: current.name }))) void deleteCollection(current.id) }}>{t('collection.delete')}</Button>
            <Button variant="primary" onClick={() => openDialog({ kind: 'editor', collectionId: current.id })}>{t('collection.addGames')}</Button>
          </>}
          {!current && hasScanFolders && <Button disabled={busy} onClick={() => void scan()}>{t('library.scan')}</Button>}
          {!current && <span className="menu-wrap">
            <Button variant="primary" disabled={busy} onClick={(e) => { e.stopPropagation(); setMenu(!menu) }}>+ {t('addGame')}</Button>
            {menu && (
              <div className="menu">
                <button onClick={() => void pick('files')}>{t('import.files')}</button>
                <button onClick={() => void pick('folder')}>{t('import.folder')}</button>
              </div>
            )}
          </span>}
        </div>
      </div>
      {busy && <div className="panel"><strong>{t('import.running')}</strong>{progress && <div className="muted">{progress.done}/{progress.total} · {progress.current}</div>}</div>}
      {result && (
        <div className="panel import-result">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{counts.length ? counts.map(([k, n]) => `${n} ${t(`import.${k}`).toLowerCase()}`).join(' · ') : t('import.nothing')}{result.ignored > 0 && ` · ${t('import.ignored', { n: result.ignored })}`}</strong>
            <Button onClick={dismissResult}>✕</Button>
          </div>
          {result.items.filter((i) => i.status !== 'added').slice(0, 20).map((i) => (
            <div key={i.file} className="muted">{itemLabel(i)} — {i.file.split(/[\\/]/).pop()}{i.error ? ` (${i.error})` : ''}</div>
          ))}
        </div>
      )}
      {loaded && games.length === 0 ? <p className="empty">{entries.length === 0 ? t('library.empty') : current && !q && games.length === 0 ? t('collection.empty') : t('library.noMatch')}<br /><span className="muted">{entries.length === 0 && t('library.dropHint')}</span></p> : (
        <div className="grid">
          {games.map((g) => <EntryCard key={g.id} entry={g} />)}
        </div>
      )}
      {over && <div className="drop-hint">{t('import.drop')}</div>}
    </div>
  )
}
