import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { t } from '@/i18n'
import { Badge, Cover, artStyle } from '@/ui'
import { useLibrary } from '@/store/library'
import { useEmulators } from '@/store/emulators'
import { useSettings } from '@/store/settings'
import { CONSOLES, consoleById } from '@shared/consoles'
import { EMULATORS } from '@shared/emulators'
import type { CatalogPage } from '@shared/catalog'
import type { LanguageSetting } from '@shared/settings'
import type { LibraryEntry } from '@shared/library'
import { focusEl, navItems, useNav } from './useNav'
import { VirtualKeyboard } from './VirtualKeyboard'
import { Detail } from './Detail'

const label = (c: string): string => consoleById(c)?.label ?? c
type Section = 'home' | 'library' | 'collections' | 'catalog' | 'settings'
const SECTIONS: Section[] = ['home', 'library', 'collections', 'catalog', 'settings']
const PAGE = 60
/** Jeu ouvert : `gameId` du catalogue (peut être null pour un fichier non reconnu) et/ou entrée de la bibliothèque. */
interface Opened { gameId: number | null; entryId?: number }
/** Dernière tuile ouverte : le focus y revient à la fermeture de la fiche. */
let lastOpened: string | null = null

function Tile({ id, gameId, title, cons, dim, fav, onOpen }: { id: string; gameId: number | null; title: string; cons: string; dim?: boolean; fav?: boolean; onOpen: () => void }) {
  const tag = <Badge>{label(cons)}</Badge>
  const name = <span className="card-title">{title}</span>
  return (
    <button data-nav data-tile={id} className={`bp-tile${dim ? ' dim' : ''}`} onClick={() => { lastOpened = id; onOpen() }}>
      {gameId !== null
        ? <Cover className="cover-fill" gameId={gameId} title={title} kind="card">{name}{tag}</Cover>
        : <div className="cover-fill" style={artStyle(title)}>{name}{tag}</div>}
      {fav && <span className="fav-mark">♥</span>}
    </button>
  )
}

export function BigPicture({ onExit }: { onExit: () => void }) {
  const entries = useLibrary((s) => s.entries)
  const collections = useLibrary((s) => s.collections)
  const running = useEmulators((s) => s.running)
  const [section, setSection] = useState<Section>('home')
  const [consoleTab, setConsoleTab] = useState('all')
  const [query, setQuery] = useState('')
  const [keyboard, setKeyboard] = useState(false)
  const [menu, setMenu] = useState(false)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [page, setPage] = useState<CatalogPage | null>(null)
  const [limit, setLimit] = useState(PAGE)

  useEffect(() => { void useLibrary.getState().refresh(); window.api.window.fullscreen(true); return () => window.api.window.fullscreen(false) }, [])
  const go = (s: Section): void => { setSection(s); setConsoleTab('all'); setQuery(''); setLimit(PAGE) }

  const playable = useMemo(() => entries.filter((e) => !e.missing).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.title.localeCompare(b.title)), [entries])
  const q = query.trim().toLowerCase()
  const libraryConsoles = useMemo(() => [...new Set(playable.map((e) => e.console))].sort((a, b) => label(a).localeCompare(label(b))), [playable])
  const libShown = playable.filter((e) => (consoleTab === 'all' || e.console === consoleTab) && (!q || e.title.toLowerCase().includes(q)))

  // Catalogue : recherche côté principal (la même que la page classique), triée par popularité.
  useEffect(() => {
    if (section !== 'catalog') return
    let stale = false
    const h = setTimeout(() => {
      void window.api.invoke('catalog:search', { q: query, consoles: consoleTab === 'all' ? [] : [consoleTab], genres: [], sort: 'popularity', dir: 'desc', limit, includeVariants: false }).then((p) => { if (!stale) setPage(p) })
    }, 150)
    return () => { stale = true; clearTimeout(h) }
  }, [section, query, consoleTab, limit])

  // Collections : seules celles qui ont au moins un jeu jouable ; sans choix explicite, la première.
  const colList = useMemo(() => collections.filter((c) => playable.some((e) => e.collections.includes(c.id))), [collections, playable])
  const activeCol = colList.find((c) => String(c.id) === consoleTab) ?? colList[0]
  const colShown = activeCol ? playable.filter((e) => e.collections.includes(activeCol.id)) : []
  const chips = section === 'collections' ? colList.map((c) => String(c.id)) : section === 'library' ? libraryConsoles : section === 'catalog' ? CONSOLES.filter((c) => (page?.consoles.find((x) => x.id === c.id)?.count ?? 0) > 0 || c.id === consoleTab).map((c) => c.id) : []
  const inGame = running.length > 0
  const overlay = keyboard || menu || opened !== null

  // Premier focus sur le contenu ; à la fermeture d'une fiche on retrouve la tuile ouverte.
  useEffect(() => {
    if (overlay || inGame) return
    const items = navItems()
    const first = items.find((e) => e.dataset.tile === lastOpened) ?? items.find((e) => e.dataset.tile !== undefined || e.classList.contains('bp-row'))
    if (!first || items.includes(document.activeElement as HTMLElement)) return
    focusEl(first)
  }, [overlay, inGame, section, consoleTab, query, playable.length, page])

  const cycle = (d: 1 | -1): void => go(SECTIONS[(SECTIONS.indexOf(section) + d + SECTIONS.length) % SECTIONS.length])

  // B : revient d'un niveau (fiche, menu, recherche). Il ne quitte jamais : c'est le menu Start qui le fait.
  const cycleFilter = (d: 1 | -1): void => {
    if (!chips.length) return
    const all = section === 'collections' ? chips : ['all', ...chips]
    const cur = section === 'collections' ? (activeCol ? String(activeCol.id) : '') : consoleTab
    setConsoleTab(all[(Math.max(0, all.indexOf(cur)) + d + all.length) % all.length]); setLimit(PAGE)
  }

  useNav((a, fromKeyboard) => {
    if (menu) { if (a === 'back' || a === 'start') setMenu(false) }
    else if (opened) { if (a === 'back') setOpened(null) }
    else if (a === 'start') setMenu(true)
    else if (a === 'prev') cycle(-1)
    else if (a === 'next') cycle(1)
    else if (a === 'prevFilter') cycleFilter(-1)
    else if (a === 'nextFilter') cycleFilter(1)
    else if (a === 'y' && (section === 'library' || section === 'catalog')) setKeyboard(true)
    else if (a === 'back' && query) setQuery('')
    // Au clavier, Échap au niveau le plus haut ouvre le menu (Reprendre / Quitter) : on peut quitter sans manette. À la manette, B ne quitte jamais.
    else if (a === 'back' && fromKeyboard) setMenu(true)
  }, !keyboard && !inGame)

  const openEntry = (e: LibraryEntry): void => setOpened({ gameId: e.gameId, entryId: e.id })
  const openedEntry = opened?.entryId !== undefined ? entries.find((e) => e.id === opened.entryId) : undefined
  const playing = entries.find((e) => running.includes(e.id))
  const libTiles = (list: LibraryEntry[], prefix: string): ReactElement[] => list.map((e) => <Tile key={`${prefix}${e.id}`} id={`${prefix}${e.id}`} gameId={e.gameId} title={e.title} cons={e.console} fav={e.favorite} onOpen={() => openEntry(e)} />)
  const searchable = section === 'library' || section === 'catalog'

  return (
    <div className="bpv" data-focus-root>
      <header className="bp-head">
        <h1>RomVault</h1>
        <div className="bp-tabs">
          <span className="bp-key">LB</span>
          {SECTIONS.map((s) => <button key={s} data-nav className={`bp-tab${section === s ? ' active' : ''}`} onClick={() => go(s)}>{t(`nav.${s}`)}</button>)}
          <span className="bp-key">RB</span>
        </div>
        {searchable && <button data-nav className="bp-search" onClick={() => setKeyboard(true)}>🔍 {query || t('bp.searchHint')}</button>}
        <button data-nav className="bp-tab bp-menu-btn" onClick={() => setMenu(true)}>☰ {t('bp.menuBtn')}</button>
      </header>
      {chips.length > 0 && (
        <div className="bp-chips">
          <span className="bp-key">LT</span>
          {(section === 'collections' ? chips : ['all', ...chips]).map((k) => {
            const active = section === 'collections' ? String(activeCol?.id) === k : consoleTab === k
            return <button key={k} data-nav className={`bp-chip${active ? ' active' : ''}`} onClick={() => { setConsoleTab(k); setLimit(PAGE) }}>{k === 'all' ? t('bp.all') : section === 'collections' ? colList.find((c) => String(c.id) === k)?.name : label(k)}</button>
          })}
          <span className="bp-key">RT</span>
        </div>
      )}

      <div className="bp-body">
        {section === 'home' && (playable.length === 0 ? <p className="empty">{t('bp.empty')}</p> : (
          <>
            {playable.some((e) => e.lastPlayed) && <><h2 className="bp-h">{t('home.continue')}</h2><div className="bp-grid">{libTiles(playable.filter((e) => e.lastPlayed).slice(0, 8), 'c')}</div></>}
            {playable.some((e) => e.favorite) && <><h2 className="bp-h">{t('home.favorites')}</h2><div className="bp-grid">{libTiles(playable.filter((e) => e.favorite).slice(0, 8), 'f')}</div></>}
            <h2 className="bp-h">{t('home.recent')}</h2>
            <div className="bp-grid">{libTiles([...playable].sort((a, b) => b.addedAt - a.addedAt).slice(0, 8), 'r')}</div>
            {colList.map((c) => <div key={c.id}><h2 className="bp-h">{c.name}</h2><div className="bp-grid">{libTiles(playable.filter((e) => e.collections.includes(c.id)).slice(0, 8), `k${c.id}-`)}</div></div>)}
          </>
        ))}

        {section === 'library' && (playable.length === 0 ? <p className="empty">{t('bp.empty')}</p> : libShown.length === 0 ? <p className="empty">{t('library.noMatch')}</p> : <div className="bp-grid">{libTiles(libShown, 'l')}</div>)}

        {section === 'collections' && (colList.length === 0 ? <p className="empty">{collections.length === 0 ? t('bp.noCollections') : t('bp.emptyCollection')}</p> : <div className="bp-grid">{libTiles(colShown, 'k')}</div>)}

        {section === 'catalog' && (
          <div className="bp-grid">
            {(page?.games ?? []).map((g) => <Tile key={g.id} id={`g${g.id}`} gameId={g.id} title={g.name} cons={g.console} dim={!entries.some((e) => e.gameId === g.id)} onOpen={() => setOpened({ gameId: g.id })} />)}
            {page && page.total > page.games.length && <button data-nav className="bp-tile bp-more" onClick={() => setLimit(limit + PAGE)}>{t('catalog.more')}</button>}
          </div>
        )}

        {section === 'settings' && <BpSettings onExit={onExit} />}
      </div>

      <footer className="bp-hints"><span>Ⓐ {t('bp.select')}</span><span>Ⓑ {t('bp.back')}</span>{searchable && <span>Ⓨ {t('bp.search')}</span>}<span>LB/RB {t('bp.section')}</span>{chips.length > 0 && <span>LT/RT {t('bp.console')}</span>}<span>☰ / Esc / F11 {t('bp.menu')}</span></footer>

      {opened && <Detail gameId={opened.gameId} entry={openedEntry} onClose={() => setOpened(null)} />}
      {keyboard && <VirtualKeyboard value={query} onChange={(v) => { setQuery(v); setLimit(PAGE) }} onClose={() => setKeyboard(false)} />}
      {menu && (
        <div className="bp-overlay">
          <div className="bp-menu" data-focus-root>
            <MenuFocus />
            <button data-nav className="bp-btn primary" onClick={() => setMenu(false)}>{t('bp.resume')}</button>
            <button data-nav className="bp-btn" onClick={onExit}>{t('bp.exit')}</button>
            <button data-nav className="bp-btn" onClick={() => window.api.window.close()}>{t('bp.quitApp')}</button>
          </div>
        </div>
      )}
      {inGame && <div className="bp-overlay solid"><div className="bp-playing"><h2>{t('bp.inGame', { title: playing?.title ?? '' })}</h2><div className="muted">{t('play.quitHint')}</div></div></div>}
    </div>
  )
}

/** Donne le focus au premier bouton du menu à son ouverture. */
function MenuFocus(): null {
  useEffect(() => { focusEl(navItems()[0]) }, [])
  return null
}

const LANGS: LanguageSetting[] = ['auto', 'en', 'fr']

/** Réglages utiles à la manette : langue, démarrage, émulateurs (installer / état), quitter. Le reste (clés API, dossiers…) reste au mode classique. */
function BpSettings({ onExit }: { onExit: () => void }) {
  const { settings, update } = useSettings()
  const { list, progress, errors, install } = useEmulators()
  const langName = (l: LanguageSetting): string => (l === 'auto' ? t('settings.langAuto') : l === 'en' ? 'English' : 'Français')
  return (
    <div className="bp-settings">
      <button data-nav className="bp-row" onClick={() => void update({ language: LANGS[(LANGS.indexOf(settings.language) + 1) % LANGS.length] })}>
        <span>{t('settings.language')}</span><strong>{langName(settings.language)}</strong>
      </button>
      <button data-nav className="bp-row" onClick={() => void update({ startInBigPicture: !settings.startInBigPicture })}>
        <span>{t('settings.startBigPicture')}</span><strong>{settings.startInBigPicture ? t('bp.on') : t('bp.off')}</strong>
      </button>
      <h2 className="bp-h">{t('nav.emulators')}</h2>
      {EMULATORS.map((def) => {
        const s = list.find((e) => e.id === def.id)
        const p = progress[def.id]
        const status = p ? t('emu.installing') : !s?.installed ? t('status.notInstalled') : s.missing ? t('emu.missing') : t('status.installed')
        const can = !p && !s?.installed
        return (
          <button key={def.id} data-nav className="bp-row" onClick={() => { if (can) void install(def.id) }}>
            <span>{def.name}<span className="muted"> · {def.consoles.map(label).join(', ')}</span></span>
            <strong>{errors[def.id] ? t('play.spawn') : can ? `${status} — ${t('emu.install')}` : status}</strong>
          </button>
        )
      })}
      <button data-nav className="bp-row" onClick={onExit}><span>{t('bp.exit')}</span></button>
    </div>
  )
}
