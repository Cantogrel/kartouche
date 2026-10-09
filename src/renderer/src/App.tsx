import { RADIUS_PX, readableOn } from '@shared/appearance'
import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { useSettings } from '@/store/settings'
import { useApp, type Route } from '@/store/app'
import { PageHead } from '@/ui'
import { useLibrary } from '@/store/library'
import { useCustomEmulators } from '@/store/customEmulators'
import { useEmulators } from '@/store/emulators'
import { useDownloads } from '@/store/downloads'
import { useUpdate } from '@/store/update'
import { useChangelog } from '@/store/changelog'
import { GameIcon } from '@/ui/ConsoleTile'
import { platformLabel } from '@shared/consoles'
import { EntryMenu, onEntryContext } from '@/ui/EntryMenu'
import { DownloadVeil } from '@/ui/EntryCard'
import { StatusBar } from '@/ui/StatusBar'
import { Dialogs } from '@/ui/CollectionDialogs'
import { ChangelogDialog } from '@/ui/ChangelogDialog'
import { AskHost } from '@/ui/AskDialog'
import { Library } from '@/pages/Library'
import { SearchBox } from '@/ui'
import { Catalog } from '@/pages/Catalog'
import { GameDetail } from '@/pages/GameDetail'
import { Home } from '@/pages/Home'
import { Emulators } from '@/pages/Emulators'
import { Settings } from '@/pages/Settings'
import { BigPicture } from '@/bigpicture/BigPicture'
import { useClassicPad } from '@/ui/useClassicPad'

const NAV: Exclude<Route, 'game'>[] = ['home', 'catalog', 'library', 'emulators', 'settings']
const ICON: Record<string, string> = { home: '⌂', catalog: '▦', library: '▤', emulators: '⚙', settings: '☰' }

export default function App() {
  const { route, gameId, go, back, history, librarySearch, setLibrarySearch, pageTitle, bigPicture, setBigPicture } = useApp()
  const { ready, load, lang } = useSettings()
  const [catalogQuery, setCatalogQuery] = useState('')
  const libEntries = useLibrary((s) => s.entries)
  // Réglage « démarrer en Big Picture » : appliqué une seule fois, au premier chargement.
  const started = useRef(false)
  const startBp = useSettings((s) => s.settings.startInBigPicture)
  useEffect(() => { if (ready && !started.current) { started.current = true; if (startBp) setBigPicture(true) } }, [ready, startBp, setBigPicture])
  useEffect(() => { void load(); void useLibrary.getState().refresh(); void useEmulators.getState().refresh(); void useCustomEmulators.getState().refresh(); void window.api.invoke('connectors:scan', undefined).then((r) => (r.some((x) => x.added > 0 || x.gone > 0) ? useLibrary.getState().refresh() : undefined)); return useEmulators.getState().listen() }, [load])
  // Barre d'état : un téléchargement démarré depuis une fiche continue, et doit y rester visible, même après avoir changé de page.
  useEffect(() => useDownloads.getState().listen(), [])
  useEffect(() => window.api.on('library:metaUpdated', () => void useLibrary.getState().refresh()), [])
  // Mises à jour : état tenu à jour partout (pas seulement pendant que Paramètres est monté), et changelog de la
  // version qu'on vient de démarrer proposé une seule fois, où que l'utilisateur se trouve dans l'app.
  useEffect(() => { void useUpdate.getState().refresh(); void useChangelog.getState().showPending(); return useUpdate.getState().listen() }, [])
  const updateStatus = useUpdate((s) => s.state.status)
  // Manette dans le mode classique (le Big Picture a la sienne).
  useClassicPad(ready && !bigPicture)
  // Thème clair/sombre : réglage 'auto' suivi en direct si l'OS change de thème pendant que l'app tourne.
  useEffect(() => useSettings.getState().listen(), [])

  const { uiScale, accent, reduceMotion, accentColor, radius, highContrast } = useSettings((s) => s.settings)
  const theme = useSettings((s) => s.theme)
  useEffect(() => {
    const el = document.documentElement
    el.style.zoom = String(uiScale)
    el.dataset.accent = accent
    el.dataset.theme = theme
    // Langue du document : choisit les polices CJK (voir styles.css) et vaut aussi pour le Big Picture, rendu hors de `.app`.
    el.lang = lang
    // Aligne le rendu natif (case à cocher, <select>, ascenseur) sur le thème choisi plutôt que sur celui de l'OS.
    el.style.colorScheme = theme
    el.classList.toggle('reduce-motion', reduceMotion)
    el.classList.toggle('high-contrast', highContrast)
    // Accent personnel : surcharge l'accent prédéfini ; le texte posé dessus est choisi pour rester lisible.
    if (accentColor) { el.style.setProperty('--accent', accentColor); el.style.setProperty('--accent-fg', readableOn(accentColor)) }
    else { el.style.removeProperty('--accent'); el.style.removeProperty('--accent-fg') }
    el.style.setProperty('--radius', `${RADIUS_PX[radius][0]}px`)
    el.style.setProperty('--radius-lg', `${RADIUS_PX[radius][1]}px`)
  }, [uiScale, accent, theme, reduceMotion, accentColor, radius, highContrast, lang])

  // Liste latérale : jeux Kartouche (ROM) puis jeux PC (exécutables, launchers), séparés par un filet ; les épinglés remontent en tête de chaque groupe.
  const sideEntries = libEntries.filter((g) => !librarySearch || g.shownTitle.toLowerCase().includes(librarySearch.toLowerCase())).sort((a, b) => Number(b.pinned) - Number(a.pinned))
  const sideGroups = { rom: sideEntries.filter((g) => g.kind === 'rom'), pc: sideEntries.filter((g) => g.kind !== 'rom') }
  const sideItem = (g: (typeof libEntries)[number]) => (

              <button key={g.id} className={`nav-item small${gameId === `lib:${g.id}` && route === 'game' ? ' active' : ''}${g.missing ? ' dim' : ''}`} aria-current={gameId === `lib:${g.id}` && route === 'game' ? 'page' : undefined} onClick={() => go('game', `lib:${g.id}`)} onContextMenu={onEntryContext(g.id)}>
                <DownloadVeil gameId={g.gameId} />
                <GameIcon gameId={g.gameId} console={g.console} art={g.art.icon ?? (g.kind !== 'rom' ? g.art.cover : undefined)} />
                <span className="side-name">{g.shownTitle}</span>{g.pinned && <span className="side-pin">★</span>}
              </button>
  )

  if (!ready) return null
  if (bigPicture) return <BigPicture onExit={() => setBigPicture(false)} />
  const title = route === 'game' && pageTitle ? pageTitle : t(`nav.${route === 'game' ? 'catalog' : route}`)
  const activeNav = route === 'game' ? (gameId?.startsWith('lib:') ? 'library' : 'catalog') : route
  return (
    <div className="app" lang={lang}>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus() }}>{t('a11y.skip')}</a>
      <div className="titlebar">
        <span>Kartouche</span>
        <div className="right">
          {(updateStatus === 'available' || updateStatus === 'downloading' || updateStatus === 'ready') && (
            <button className="update-badge" onClick={() => go('settings', 'about')}>
              ⭳ {t(updateStatus === 'downloading' ? 'update.badgeDownloading' : updateStatus === 'ready' ? 'update.badgeReady' : 'update.badgeAvailable', { percent: useUpdate.getState().state.percent })}
            </button>
          )}
          <button className="bp-launch" onClick={() => setBigPicture(true)}>▶ {t('bigpicture')}</button>
          <button aria-label={t('a11y.minimize')} title={t('a11y.minimize')} onClick={() => window.api.window.minimize()}>–</button>
          <button aria-label={t('a11y.maximize')} title={t('a11y.maximize')} onClick={() => window.api.window.maximize()}>▢</button>
          <button aria-label={t('a11y.close')} title={t('a11y.close')} onClick={() => window.api.window.close()}>✕</button>
        </div>
      </div>
      <div className="body">
        <nav className="sidebar" aria-label={t('a11y.nav')}>
          {NAV.map((r) => (
            <button key={r} className={`nav-item${activeNav === r ? ' active' : ''}`} aria-current={activeNav === r ? 'page' : undefined} onClick={() => go(r)}>
              <span className="ico" aria-hidden>{ICON[r]}</span>{t(`nav.${r}`)}
            </button>
          ))}
          <div className="side-lib">
          <SearchBox className="side" placeholder={t('searchLibrary')} value={librarySearch} onChange={setLibrarySearch} clearLabel={t('search.clear')} />
          <div className="side-games" role="group" aria-label={t('a11y.games')}>
            {sideGroups.rom.map(sideItem)}
            {sideGroups.pc.length > 0 && sideGroups.rom.length > 0 && <div className="side-sep" role="separator">{platformLabel('pc')}</div>}
            {sideGroups.pc.map(sideItem)}
          </div>
          </div>
        </nav>
        <main className="main" id="main" tabIndex={-1}>
          <PageHead title={title} onBack={history.length ? back : undefined}>
            {route === 'catalog' && <SearchBox placeholder={t('search')} value={catalogQuery} onChange={setCatalogQuery} clearLabel={t('search.clear')} />}
          </PageHead>
          {route === 'home' && <Home />}
          {route === 'catalog' && <Catalog query={catalogQuery} />}
          {route === 'library' && <Library />}
          {route === 'game' && <GameDetail gameId={gameId} />}
          {route === 'emulators' && <Emulators />}
          {route === 'settings' && <Settings />}
        </main>
      </div>
      <EntryMenu />
      <Dialogs />
      <ChangelogDialog />
      <AskHost />
      <StatusBar />
    </div>
  )
}
