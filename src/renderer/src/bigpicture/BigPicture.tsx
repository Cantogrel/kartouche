import { useEffect, useMemo, useState } from 'react'
import { t } from '@/i18n'
import { Cover } from '@/ui'
import { ConsoleTile } from '@/ui/ConsoleTile'
import { useLibrary } from '@/store/library'
import { useEmulators } from '@/store/emulators'
import { emulatorForConsole } from '@shared/emulators'
import { consoleById } from '@shared/consoles'
import type { LibraryEntry } from '@shared/library'
import { focusEl, navItems, useNav } from './useNav'
import { VirtualKeyboard } from './VirtualKeyboard'

const label = (c: string): string => consoleById(c)?.label ?? c

/** Fenêtre d'un jeu : jaquette, temps de jeu, lancement. Le lancement se fait au bouton A, sans souris. */
function Detail({ entry, onClose }: { entry: LibraryEntry; onClose: () => void }) {
  const running = useEmulators((s) => s.running.includes(entry.id))
  const play = useEmulators((s) => s.play)
  const def = emulatorForConsole(entry.console)
  const installed = useEmulators((s) => s.list.find((e) => e.id === def?.id)?.installed)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { focusEl(navItems()[0]) }, [])
  const launch = async (): Promise<void> => {
    if (def && installed === false) { setError(t('play.notInstalled')); return }
    const r = await play(entry.id)
    setError(r.ok ? null : t(`play.${r.error ?? 'spawn'}`) + (r.detail && r.error === 'spawn' ? ` (${r.detail})` : ''))
  }
  return (
    <div className="bp-overlay">
      <div className="bp-detail" data-focus-root>
        {entry.gameId !== null && <Cover className="bp-detail-cover" gameId={entry.gameId} title={entry.title} kind="card" />}
        <div className="bp-detail-body">
          <h2>{entry.title}</h2>
          <div className="muted">{label(entry.console)} · {t('bp.played', { n: entry.playMinutes })}</div>
          {error && <div className="bp-error">{error}</div>}
          <div className="bp-actions">
            {running
              ? <button data-nav className="bp-btn primary" onClick={() => void window.api.invoke('game:stop', entry.id)}>■ {t('play.stop')}</button>
              : <button data-nav className="bp-btn primary" onClick={() => void launch()}>▶ {t('play')}</button>}
            <button data-nav className="bp-btn" onClick={onClose}>{t('bp.back')}</button>
          </div>
          <div className="muted">{t('play.quitHint')}</div>
        </div>
      </div>
    </div>
  )
}

export function BigPicture({ onExit }: { onExit: () => void }) {
  const entries = useLibrary((s) => s.entries)
  const running = useEmulators((s) => s.running)
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState('')
  const [keyboard, setKeyboard] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  useEffect(() => { void useLibrary.getState().refresh(); window.api.window.fullscreen(true); return () => window.api.window.fullscreen(false) }, [])

  const playable = useMemo(() => entries.filter((e) => !e.missing).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.title.localeCompare(b.title)), [entries])
  const consoles = useMemo(() => [...new Set(playable.map((e) => e.console))].sort((a, b) => label(a).localeCompare(label(b))), [playable])
  const tabs = ['all', ...consoles]
  const q = query.trim().toLowerCase()
  const shown = playable.filter((e) => (tab === 'all' || e.console === tab) && (!q || e.title.toLowerCase().includes(q)))
  const open = playable.find((e) => e.id === openId) ?? null
  const inGame = running.length > 0

  // Premier focus sur la grille (ou, sans jeu, sur l'onglet) ; retour de la fiche → on retrouve la tuile.
  useEffect(() => {
    if (keyboard || open || inGame || !playable.length) return
    const items = navItems()
    if (items.includes(document.activeElement as HTMLElement)) return
    const tile = items.find((e) => e.dataset.entry !== undefined && e.dataset.entry === String(lastOpened))
    focusEl(tile ?? items.find((e) => e.dataset.entry !== undefined) ?? items[0])
  }, [keyboard, open, inGame, tab, query, playable.length])

  const cycle = (d: 1 | -1): void => { setTab(tabs[(Math.max(0, tabs.indexOf(tab)) + d + tabs.length) % tabs.length]) }

  useNav((a) => {
    if (a === 'start') onExit()
    else if (open) { if (a === 'back') { setOpenId(null) } }
    else if (a === 'prev') cycle(-1)
    else if (a === 'next') cycle(1)
    else if (a === 'y') setKeyboard(true)
    else if (a === 'back') { if (query) setQuery(''); else onExit() }
  }, !keyboard && !inGame)

  const openEntry = (e: LibraryEntry): void => { lastOpened = e.id; setOpenId(e.id) }
  const playing = playable.find((e) => running.includes(e.id))

  return (
    <div className="bp" data-focus-root>
      <header className="bp-head">
        <h1>RomVault</h1>
        <div className="bp-tabs">
          <span className="bp-key">LB</span>
          {tabs.map((k) => <button key={k} data-nav className={`bp-tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{k === 'all' ? t('bp.all') : label(k)}</button>)}
          <span className="bp-key">RB</span>
        </div>
        <button data-nav className="bp-search" onClick={() => setKeyboard(true)}>🔍 {query || t('bp.searchHint')}</button>
      </header>
      {playable.length === 0 ? <p className="empty">{t('bp.empty')}</p> : shown.length === 0 ? <p className="empty">{t('library.noMatch')}</p> : (
        <div className="bp-grid">
          {shown.map((e) => (
            <button key={e.id} data-nav data-entry={e.id} className="bp-tile" onClick={() => openEntry(e)}>
              {e.gameId !== null ? <Cover className="cover-fill" gameId={e.gameId} title={e.title} kind="card" /> : <div className="cover-fill bp-noart"><ConsoleTile id={e.console} /></div>}
              <span className="card-title">{e.title}</span>
            </button>
          ))}
        </div>
      )}
      <footer className="bp-hints"><span>Ⓐ {t('bp.select')}</span><span>Ⓑ {t('bp.back')}</span><span>Ⓨ {t('bp.search')}</span><span>LB/RB {t('bp.console')}</span><span>☰ {t('bp.exit')}</span></footer>
      {open && <Detail entry={open} onClose={() => setOpenId(null)} />}
      {keyboard && <VirtualKeyboard value={query} onChange={setQuery} onClose={() => setKeyboard(false)} />}
      {inGame && <div className="bp-overlay solid"><div className="bp-playing"><h2>{t('bp.inGame', { title: playing?.title ?? '' })}</h2><div className="muted">{t('play.quitHint')}</div></div></div>}
    </div>
  )
}

/** Dernière tuile ouverte : le focus y revient à la fermeture de la fiche. */
let lastOpened: number | null = null
