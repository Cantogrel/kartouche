import { confirmDialog } from '@/ui/AskDialog'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Button, Pill } from '@/ui'
import { EntryCard } from '@/ui/EntryCard'
import { useDialog } from '@/ui/CollectionDialogs'
import { t } from '@/i18n'
import { useApp, type LibraryTab } from '@/store/app'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import { onEntryContext } from '@/ui/EntryMenu'
import { consoleById } from '@shared/consoles'
import { orderConsolesByRecency, type ImportItem } from '@shared/library'

const labelOf = (id: string): string => consoleById(id)?.label ?? id
const itemLabel = (i: ImportItem): string => t(`import.${i.status}`)
// Position de scroll de la grille, conservée hors de l'état React pour survivre au démontage de la page (fiche jeu puis retour).
let lastScrollTop = 0

export function Library() {
  const { librarySearch, library: view, setLibraryView } = useApp()
  const { tab, consoleFilter } = view
  const setTab = (next: LibraryTab): void => setLibraryView({ tab: next })
  const setConsoleFilter = (c: string | null): void => setLibraryView({ consoleFilter: c })
  const { entries, collections, loaded, busy, progress, result, refresh, importPaths, scan, dismissResult, deleteCollection } = useLibrary()
  const hasScanFolders = useSettings((s) => s.settings.scanFolders.length > 0)
  const [over, setOver] = useState(false)
  const [menu, setMenu] = useState(false)
  const openDialog = useDialog((s) => s.open)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRestored = useRef(false)
  // Remonte à la position de scroll précédente une fois la liste chargée (retour depuis la fiche d'un jeu).
  useLayoutEffect(() => {
    if (scrollRestored.current || !loaded || !contentRef.current) return
    scrollRestored.current = true
    contentRef.current.scrollTop = lastScrollTop
  }, [loaded])
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
  const libraryConsoles = useMemo(() => orderConsolesByRecency(entries), [entries])
  // Le jeu de la dernière console visible peut avoir été retiré de la bibliothèque entre-temps.
  useEffect(() => { if (consoleFilter && loaded && !libraryConsoles.includes(consoleFilter)) setConsoleFilter(null) }, [consoleFilter, libraryConsoles, loaded])
  const games = entries
    .filter((g) => (tab === 'ready' ? !g.missing : tab === 'missing' ? g.missing : tab === 'favorites' ? g.favorite : collectionId !== null ? g.collections.includes(collectionId) : true))
    .filter((g) => !consoleFilter || g.console === consoleFilter)
    .filter((g) => !q || g.title.toLowerCase().includes(q))
    // Épinglé : remonte en tête de la grille (pas seulement de la liste latérale), sans changer l'ordre du reste.
    .sort((a, b) => Number(b.pinned) - Number(a.pinned))
  const pick = async (kind: 'files' | 'folder'): Promise<void> => { setMenu(false); await importPaths(await window.api.invoke('library:pick', kind)) }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault(); setOver(false)
    void importPaths([...e.dataTransfer.files].map((f) => window.api.pathOf(f)).filter(Boolean))
  }
  const current = collectionId !== null ? collections.find((c) => c.id === collectionId) : undefined
  const counts = result ? (['added', 'duplicate', 'ambiguous', 'error'] as const).map((k) => [k, result.items.filter((i) => i.status === k).length] as const).filter(([, n]) => n > 0) : []

  return (
    <div className={`content dropzone${over ? ' over' : ''}`} ref={contentRef} onScroll={(e) => { lastScrollTop = e.currentTarget.scrollTop }} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false) }} onDrop={onDrop}>
      <div className="toolbar">
        <div className="row">
          {(['all', 'ready', 'missing', 'favorites'] as LibraryTab[]).map((k) => <Pill key={k} active={tab === k} onClick={() => setTab(k)}>{k === 'favorites' ? '♥ ' : ''}{t(`tab.${k}`)}</Pill>)}
          {collections.length > 0 && (
            <select className={`collection-select${current ? ' active' : ''}`} value={collectionId ?? ''} aria-label={t('nav.collections')}
              onChange={(e) => setTab(e.target.value ? (`c${e.target.value}` as LibraryTab) : 'all')}>
              <option value="">{t('collection.select')}</option>
              {collections.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
            </select>
          )}
          <Pill onClick={() => openDialog({ kind: 'editor', collectionId: null })}>{t('collection.new')}</Pill>
        </div>
        <div className="row">
          {current && <>
            <Button onClick={() => openDialog({ kind: 'editor', collectionId: current.id })}>{t('collection.edit')}</Button>
            <Button onClick={async () => { if (await confirmDialog(t('collection.confirmDelete', { name: current.name }))) void deleteCollection(current.id) }}>{t('collection.delete')}</Button>
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
      {libraryConsoles.length > 1 && (
        <div className="row lib-consoles">
          <Pill active={!consoleFilter} onClick={() => setConsoleFilter(null)}>{t('filter.allConsoles')}</Pill>
          {libraryConsoles.map((c) => <Pill key={c} active={consoleFilter === c} onClick={() => setConsoleFilter(c)}>{labelOf(c)}</Pill>)}
        </div>
      )}
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
      {!loaded ? (
        <div className="grid">{Array.from({ length: 12 }).map((_, i) => <div key={i} className="card skeleton-item skeleton-block" />)}</div>
      ) : games.length === 0 ? (
        <p className="empty">{entries.length === 0 ? t('library.empty') : current && !q && games.length === 0 ? t('collection.empty') : t('library.noMatch')}<br /><span className="muted">{entries.length === 0 && t('library.dropHint')}</span></p>
      ) : (
        <div className="grid">
          {games.map((g) => <EntryCard key={g.id} entry={g} />)}
        </div>
      )}
      {over && <div className="drop-hint">{t('import.drop')}</div>}
    </div>
  )
}
