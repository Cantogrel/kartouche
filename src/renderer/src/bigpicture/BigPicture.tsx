import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { t } from '@/i18n'
import { Badge, Cover, artStyle } from '@/ui'
import { useLibrary } from '@/store/library'
import { useDownloads } from '@/store/downloads'
import { DownloadVeil } from '@/ui/EntryCard'
import { useEmulators } from '@/store/emulators'
import { useSettings } from '@/store/settings'
import { CONSOLES, platformLabel } from '@shared/consoles'
import { EMULATORS } from '@shared/emulators'
import type { CatalogPage } from '@shared/catalog'
import type { LanguageSetting } from '@shared/settings'
import { orderConsolesByRecency, type LibraryEntry } from '@shared/library'
import { focusEl, navItems, useNav, useTypeText } from './useNav'
import type { CatalogGame } from '@shared/catalog'
import { VirtualKeyboard } from './VirtualKeyboard'
import { Detail } from './Detail'

const label = (c: string): string => platformLabel(c)
type Section = 'home' | 'library' | 'collections' | 'catalog' | 'settings'
const SECTIONS: Section[] = ['home', 'library', 'collections', 'catalog', 'settings']
const PAGE = 60
const MOUSE_IDLE_MS = 3000
/** Jeu ouvert : `gameId` du catalogue (peut être null pour un fichier non reconnu) et/ou entrée de la bibliothèque. */
interface Opened { gameId: number | null; entryId?: number }
/** Dernière tuile ouverte : le focus y revient à la fermeture de la fiche. */
let lastOpened: string | null = null

function Tile({ id, gameId, entryId, title, art, cons, dim, fav, pinned, state, onOpen }: { id: string; gameId: number | null; entryId?: number; title: string; /** image personnelle de la jaquette (chemin relatif) */ art?: string; cons: string; dim?: boolean; fav?: boolean; pinned?: boolean; state?: 'installed' | 'library' | 'downloading'; onOpen: () => void }) {
  const tag = <Badge>{label(cons)}</Badge>
  const name = <span className="card-title">{title}</span>
  return (
    <button data-nav data-tile={id} data-entry={entryId} className={`bp-tile${dim ? ' dim' : ''}`} onClick={() => { lastOpened = id; onOpen() }}>
      {gameId !== null || art
        ? <Cover className="cover-fill" gameId={gameId} art={art} title={title} kind="tile">{name}{tag}</Cover>
        : <div className="cover-fill" style={artStyle(title)}>{name}{tag}</div>}
      <DownloadVeil gameId={gameId} />
      {fav && <span className="fav-mark">♥</span>}
      {pinned && <span className="pin-mark">★</span>}
      {state && <span className={`state-mark ${state}`}>{t(state === 'installed' ? 'catalog.installed' : state === 'downloading' ? 'catalog.downloading' : 'catalog.inLibrary')}</span>}
    </button>
  )
}

export function BigPicture({ onExit }: { onExit: () => void }) {
  const entries = useLibrary((s) => s.entries)
  const jobs = useDownloads((s) => s.jobs)
  const downloadingGames = new Set(Object.values(jobs).flatMap((j) => (j.gameId !== undefined ? [j.gameId] : [])))
  const catalogState = (gameId: number): 'installed' | 'library' | undefined => {
    const mine = entries.filter((e) => e.gameId === gameId)
    return mine.length === 0 ? undefined : mine.some((e) => !e.missing) ? 'installed' : 'library'
  }
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
  const grid = useRef<HTMLDivElement>(null)
  // « Charger plus » : le bouton glisse sous les nouvelles tuiles et garde le focus, hors champ — la vue ne suit pas et la
  // direction suivante repart du bas de la liste. On rend le focus à la première tuile ajoutée (index dans la grille).
  const focusAfterMore = useRef<number | null>(null)
  useEffect(() => {
    const from = focusAfterMore.current
    if (from === null || !page || page.games.length <= from) return
    focusAfterMore.current = null
    focusEl(grid.current?.querySelectorAll<HTMLElement>('[data-nav]:not(.bp-more)')[from])
  }, [page])

  // Souris masquée après quelques secondes sans mouvement (interface pensée pour la manette), réaffichée au moindre mouvement.
  const [idleMouse, setIdleMouse] = useState(false)
  useEffect(() => {
    let h = setTimeout(() => setIdleMouse(true), MOUSE_IDLE_MS)
    const move = (): void => { setIdleMouse(false); clearTimeout(h); h = setTimeout(() => setIdleMouse(true), MOUSE_IDLE_MS) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mousedown', move)
    return () => { clearTimeout(h); window.removeEventListener('mousemove', move); window.removeEventListener('mousedown', move) }
  }, [])

  useEffect(() => { void useLibrary.getState().refresh(); window.api.window.fullscreen(true); return () => window.api.window.fullscreen(false) }, [])
  const go = (s: Section): void => { setSection(s); setConsoleTab('all'); setQuery(''); setLimit(PAGE) }

  const playable = useMemo(() => entries.filter((e) => !e.missing).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || a.shownTitle.localeCompare(b.shownTitle)), [entries])
  const q = query.trim().toLowerCase()
  const libraryConsoles = useMemo(() => orderConsolesByRecency(playable), [playable])
  const libShown = playable.filter((e) => (consoleTab === 'all' || e.console === consoleTab) && (!q || e.shownTitle.toLowerCase().includes(q)))

  // Jeux en cours de téléchargement : visibles dans la bibliothèque (entrée sans fichier, ou jeu pas encore ajouté) tant que le job existe —
  // annulé ou échoué, il quitte le store et disparaît d'ici.
  const dlKey = [...downloadingGames].sort((a, b) => a - b).join(',')
  const [dlCatalog, setDlCatalog] = useState<Record<number, CatalogGame>>({})
  useEffect(() => {
    for (const id of downloadingGames) {
      if (entries.some((e) => e.gameId === id) || dlCatalog[id]) continue
      void window.api.invoke('catalog:get', id).then((g) => { if (g) setDlCatalog((p) => ({ ...p, [id]: g })) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlKey, entries])
  const matches = (title: string, cons: string): boolean => (consoleTab === 'all' || cons === consoleTab) && (!q || title.toLowerCase().includes(q))
  const dlEntries = entries.filter((e) => e.missing && e.gameId !== null && downloadingGames.has(e.gameId) && matches(e.shownTitle, e.console))
  const dlGames = [...downloadingGames].filter((id) => !entries.some((e) => e.gameId === id) && dlCatalog[id] && matches(dlCatalog[id].name, dlCatalog[id].console)).map((id) => dlCatalog[id])

  // Catalogue : recherche côté principal (la même que la page classique), triée par popularité.
  useEffect(() => {
    if (section !== 'catalog') return
    let stale = false
    const h = setTimeout(() => {
      void window.api.invoke('catalog:search', { q: query, consoles: consoleTab === 'all' ? [] : [consoleTab], genres: [], sort: 'popularity', dir: 'desc', limit, includeVariants: false }).then((p) => { if (!stale) setPage(p) })
    }, 150)
    return () => { stale = true; clearTimeout(h) }
  }, [section, query, consoleTab, limit])

  // Collections : seules celles qui ont au moins un jeu jouable, plus « Favoris » en tête (mis en avant comme une
  // collection bien que ça n'en soit pas techniquement une) dès qu'il y a au moins un favori. Sans choix explicite,
  // la première (Favoris si présente, sinon la première vraie collection).
  const colList = useMemo(() => collections.filter((c) => playable.some((e) => e.collections.includes(c.id))), [collections, playable])
  const hasFav = playable.some((e) => e.favorite)
  const colKeys = useMemo(() => [...(hasFav ? ['fav'] : []), ...colList.map((c) => String(c.id))], [hasFav, colList])
  const activeColKey = colKeys.includes(consoleTab) ? consoleTab : colKeys[0]
  const activeCol = activeColKey && activeColKey !== 'fav' ? colList.find((c) => String(c.id) === activeColKey) : undefined
  const colShown = activeColKey === 'fav' ? playable.filter((e) => e.favorite) : activeCol ? playable.filter((e) => e.collections.includes(activeCol.id)) : []
  const chips = section === 'collections' ? colKeys : section === 'library' ? libraryConsoles : section === 'catalog' ? CONSOLES.filter((c) => (page?.consoles.find((x) => x.id === c.id)?.count ?? 0) > 0 || c.id === consoleTab).map((c) => c.id) : []
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
    const cur = section === 'collections' ? (activeColKey ?? '') : consoleTab
    setConsoleTab(all[(Math.max(0, all.indexOf(cur)) + d + all.length) % all.length]); setLimit(PAGE)
  }

  useNav((a, fromKeyboard) => {
    if (menu) { if (a === 'back' || a === 'start') setMenu(false) }
    else if (opened) {
      if (a === 'back') setOpened(null)
      // X bascule les favoris depuis la fiche sans devoir y amener le focus (cf. Detail.tsx, indice Ⓧ).
      else if (a === 'x') {
        const e = opened.entryId !== undefined ? entries.find((en) => en.id === opened.entryId) : entries.find((en) => en.gameId === opened.gameId)
        if (e) void useLibrary.getState().setFlag(e.id, { favorite: !e.favorite })
      }
    }
    else if (a === 'start') setMenu(true)
    else if (a === 'prev') cycle(-1)
    else if (a === 'next') cycle(1)
    else if (a === 'prevFilter') cycleFilter(-1)
    else if (a === 'nextFilter') cycleFilter(1)
    else if (a === 'y' && (section === 'library' || section === 'catalog')) setKeyboard(true)
    // X bascule les favoris de la tuile qui a le focus, même sans avoir ouvert sa fiche (cf. data-entry posé par Tile).
    else if (a === 'x') {
      const raw = (document.activeElement as HTMLElement | null)?.dataset.entry
      const id = raw !== undefined ? Number(raw) : NaN
      const e = Number.isFinite(id) ? entries.find((en) => en.id === id) : undefined
      if (e) void useLibrary.getState().setFlag(e.id, { favorite: !e.favorite })
    }
    else if (a === 'back' && query) setQuery('')
    // Au clavier, Échap au niveau le plus haut ouvre le menu (Reprendre / Quitter) : on peut quitter sans manette. À la manette, B ne quitte jamais.
    else if (a === 'back' && fromKeyboard) setMenu(true)
  }, !keyboard && !inGame)

  const openEntry = (e: LibraryEntry): void => setOpened({ gameId: e.gameId, entryId: e.id })
  const openedEntry = opened?.entryId !== undefined ? entries.find((e) => e.id === opened.entryId) : undefined
  const playing = entries.find((e) => running.includes(e.id))
  const libTiles = (list: LibraryEntry[], prefix: string): ReactElement[] => list.map((e) => <Tile key={`${prefix}${e.id}`} id={`${prefix}${e.id}`} gameId={e.gameId} entryId={e.id} title={e.shownTitle} art={e.art.cover} cons={e.console} fav={e.favorite} pinned={e.pinned} onOpen={() => openEntry(e)} />)
  const searchable = section === 'library' || section === 'catalog'
  // Clavier physique : on tape directement la recherche (le clavier virtuel reste pour la manette).
  useTypeText(query, (v) => { setQuery(v); setLimit(PAGE) }, searchable && !overlay && !inGame)

  return (
    <div className={`bpv${idleMouse ? ' mouse-idle' : ''}`} data-focus-root>
      <header className="bp-head">
        <h1>Kartouche</h1>
        <div className="bp-tabs">
          <span className="bp-key">LB</span>
          {/* Sections : LB/RB seulement, jamais le focus du stick (déjà accessibles à la gachette). */}
          {SECTIONS.map((s) => <button key={s} className={`bp-tab${section === s ? ' active' : ''}`} onClick={() => go(s)}>{t(`nav.${s}`)}</button>)}
          <span className="bp-key">RB</span>
        </div>
        {searchable && <button data-nav className="bp-search" onClick={() => setKeyboard(true)}>🔍 {query || t('bp.searchHint')}</button>}
        <button data-nav className="bp-tab bp-menu-btn" onClick={() => setMenu(true)}>☰ {t('bp.menuBtn')}</button>
      </header>
      {chips.length > 0 && (
        <div className="bp-chips">
          <span className="bp-key">LT</span>
          {/* Filtres console/collection : LT/RT seulement, jamais le focus du stick (déjà accessibles à la gachette). */}
          {(section === 'collections' ? chips : ['all', ...chips]).map((k) => {
            const active = section === 'collections' ? activeColKey === k : consoleTab === k
            return <button key={k} className={`bp-chip${active ? ' active' : ''}`} onClick={() => { setConsoleTab(k); setLimit(PAGE) }}>{k === 'all' ? t('bp.all') : section === 'collections' ? (k === 'fav' ? t('home.favorites') : colList.find((c) => String(c.id) === k)?.name) : label(k)}</button>
          })}
          <span className="bp-key">RT</span>
        </div>
      )}

      {/* data-scroll : défilable au stick droit, comme la description d'une fiche — seulement pris en compte quand aucune fiche/menu n'a la main (racine de focus = .bpv, cf. activeRoot dans useNav.ts). */}
      <div className="bp-body" data-scroll>
        {section === 'home' && (playable.length === 0 ? <p className="empty">{t('bp.empty')}</p> : (
          <>
            {playable.some((e) => e.lastPlayed) && <><h2 className="bp-h">{t('home.continue')}</h2><div className="bp-grid">{libTiles(playable.filter((e) => e.lastPlayed).slice(0, 8), 'c')}</div></>}
            {playable.some((e) => e.favorite) && <><h2 className="bp-h">{t('home.favorites')}</h2><div className="bp-grid">{libTiles(playable.filter((e) => e.favorite).slice(0, 8), 'f')}</div></>}
            <h2 className="bp-h">{t('home.recent')}</h2>
            <div className="bp-grid">{libTiles([...playable].sort((a, b) => b.addedAt - a.addedAt).slice(0, 8), 'r')}</div>
            {colList.map((c) => <div key={c.id}><h2 className="bp-h">{c.name}</h2><div className="bp-grid">{libTiles(playable.filter((e) => e.collections.includes(c.id)).slice(0, 8), `k${c.id}-`)}</div></div>)}
          </>
        ))}

        {section === 'library' && (playable.length + dlEntries.length + dlGames.length === 0 ? <p className="empty">{t('bp.empty')}</p> : libShown.length + dlEntries.length + dlGames.length === 0 ? <p className="empty">{t('library.noMatch')}</p> : (
          <div className="bp-grid">
            {dlEntries.map((e) => <Tile key={`d${e.id}`} id={`d${e.id}`} gameId={e.gameId} entryId={e.id} title={e.shownTitle} art={e.art.cover} cons={e.console} state="downloading" onOpen={() => openEntry(e)} />)}
            {dlGames.map((g) => <Tile key={`dg${g.id}`} id={`dg${g.id}`} gameId={g.id} title={g.name} cons={g.console} state="downloading" onOpen={() => setOpened({ gameId: g.id })} />)}
            {libTiles(libShown, 'l')}
          </div>
        ))}

        {section === 'collections' && (colKeys.length === 0 ? <p className="empty">{collections.length === 0 ? t('bp.noCollections') : t('bp.emptyCollection')}</p> : <div className="bp-grid">{libTiles(colShown, 'k')}</div>)}

        {section === 'catalog' && (
          <div className="bp-grid" ref={grid}>
            {(page?.games ?? []).map((g) => <Tile key={g.id} id={`g${g.id}`} gameId={g.id} entryId={entries.find((e) => e.gameId === g.id)?.id} title={g.name} cons={g.console} dim={!entries.some((e) => e.gameId === g.id) && !downloadingGames.has(g.id)} state={downloadingGames.has(g.id) ? 'downloading' : catalogState(g.id)} onOpen={() => setOpened({ gameId: g.id })} />)}
            {page && page.total > page.games.length && <button data-nav className="bp-tile bp-more" onClick={() => { focusAfterMore.current = page.games.length; setLimit(limit + PAGE) }}>{t('catalog.more')}</button>}
          </div>
        )}

        {section === 'settings' && <BpSettings onExit={onExit} />}
      </div>

      <footer className="bp-hints"><span>Ⓐ {t('bp.select')}</span><span>Ⓑ {t('bp.back')}</span>{section !== 'settings' && <span>Ⓧ {t('home.favorites')}</span>}{searchable && <span>Ⓨ {t('bp.search')}</span>}<span>LB/RB {t('bp.section')}</span>{chips.length > 0 && <span>LT/RT {t('bp.console')}</span>}<span>☰ / Esc / F11 {t('bp.menu')}</span></footer>

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
      {inGame && <div className="bp-overlay solid"><div className="bp-playing"><h2>{t('bp.inGame', { title: playing?.shownTitle ?? '' })}</h2><div className="muted">{t('play.quitHint')}</div></div></div>}
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
