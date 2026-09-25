import { useEffect, useState, type DragEvent } from 'react'
import { Badge, Button, Cover, GameCard, Pill } from '@/ui'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import { consoleById } from '@shared/consoles'
import type { ImportItem } from '@shared/library'

type Tab = 'all' | 'ready' | 'missing'

const itemLabel = (i: ImportItem): string => t(`import.${i.status}`)

export function Library() {
  const { go, librarySearch } = useApp()
  const { entries, loaded, busy, progress, result, refresh, importPaths, scan, dismissResult } = useLibrary()
  const hasScanFolders = useSettings((s) => s.settings.scanFolders.length > 0)
  const [tab, setTab] = useState<Tab>('all')
  const [over, setOver] = useState(false)
  const [menu, setMenu] = useState(false)
  useEffect(() => { void refresh() }, [refresh])

  const q = librarySearch.trim().toLowerCase()
  const games = entries
    .filter((g) => (tab === 'ready' ? !g.missing : tab === 'missing' ? g.missing : true))
    .filter((g) => !q || g.title.toLowerCase().includes(q))
  const pick = async (kind: 'files' | 'folder'): Promise<void> => { setMenu(false); await importPaths(await window.api.invoke('library:pick', kind)) }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault(); setOver(false)
    void importPaths([...e.dataTransfer.files].map((f) => window.api.pathOf(f)).filter(Boolean))
  }
  const counts = result ? (['added', 'duplicate', 'ambiguous', 'error'] as const).map((k) => [k, result.items.filter((i) => i.status === k).length] as const).filter(([, n]) => n > 0) : []

  return (
    <div className={`content dropzone${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false) }} onDrop={onDrop}>
      <div className="toolbar">
        <div className="row">
          {(['all', 'ready', 'missing'] as Tab[]).map((k) => <Pill key={k} active={tab === k} onClick={() => setTab(k)}>{t(`tab.${k}`)}</Pill>)}
        </div>
        <div className="row">
          {hasScanFolders && <Button disabled={busy} onClick={() => void scan()}>{t('library.scan')}</Button>}
          <span className="menu-wrap">
            <Button variant="primary" disabled={busy} onClick={() => setMenu(!menu)}>+ {t('addGame')}</Button>
            {menu && (
              <div className="menu">
                <button onClick={() => void pick('files')}>{t('import.files')}</button>
                <button onClick={() => void pick('folder')}>{t('import.folder')}</button>
              </div>
            )}
          </span>
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
      {loaded && games.length === 0 ? <p className="empty">{entries.length === 0 ? t('library.empty') : t('library.noMatch')}<br /><span className="muted">{entries.length === 0 && t('library.dropHint')}</span></p> : (
        <div className="grid">
          {games.map((g) => {
            const label = consoleById(g.console)?.label ?? g.console
            const open = (): void => go('game', `lib:${g.id}`)
            return g.gameId === null ? (
              <GameCard key={g.id} title={g.title} console={label} hasFile={!g.missing} onClick={open} />
            ) : (
              <div key={g.id} className={`card${g.missing ? ' nofile' : ''}`} tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()}>
                <Cover className="cover-fill" gameId={g.gameId} title={g.title} kind="card"><span className="card-title">{g.title}</span><Badge>{label}</Badge></Cover>
              </div>
            )
          })}
        </div>
      )}
      {over && <div className="drop-hint">{t('import.drop')}</div>}
    </div>
  )
}
