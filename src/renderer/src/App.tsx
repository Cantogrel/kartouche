import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { useSettings } from '@/store/settings'
import { useApp, type Route } from '@/store/app'
import { PageHead } from '@/ui'
import { DEMO_GAMES } from '@/data/demo'
import { useLibrary } from '@/store/library'
import { Cover } from '@/ui'
import { EntryMenu, onEntryContext } from '@/ui/EntryMenu'
import { Library } from '@/pages/Library'
import { SearchBox } from '@/ui'
import { Catalog } from '@/pages/Catalog'
import { GameDetail } from '@/pages/GameDetail'
import { Home } from '@/pages/Home'
import { Emulators } from '@/pages/Emulators'
import { Settings } from '@/pages/Settings'

const NAV: Exclude<Route, 'game'>[] = ['home', 'catalog', 'library', 'emulators', 'settings']
const ICON: Record<string, string> = { home: '⌂', catalog: '▦', library: '▤', emulators: '⚙', settings: '☰' }

export default function App() {
  const { route, gameId, go, back, history, librarySearch, setLibrarySearch, pageTitle } = useApp()
  const { ready, load } = useSettings()
  const [catalogQuery, setCatalogQuery] = useState('')
  const libEntries = useLibrary((s) => s.entries)
  useEffect(() => { void load(); void useLibrary.getState().refresh() }, [load])

  if (!ready) return null
  const game = route === 'game' ? DEMO_GAMES.find((g) => g.id === gameId) : undefined
  const title = game ? game.title : route === 'game' && pageTitle ? pageTitle : t(`nav.${route === 'game' ? 'catalog' : route}`)
  const activeNav = route === 'game' ? (game || gameId?.startsWith('lib:') ? 'library' : 'catalog') : route
  return (
    <div className="app">
      <div className="titlebar">
        <span>RomVault</span>
        <div className="right">
          <button className="bp" onClick={() => undefined}>▶ {t('bigpicture')}</button>
          <button onClick={() => window.api.window.minimize()}>–</button>
          <button onClick={() => window.api.window.maximize()}>▢</button>
          <button onClick={() => window.api.window.close()}>✕</button>
        </div>
      </div>
      <div className="body">
        <nav className="sidebar">
          {NAV.map((r) => (
            <button key={r} className={`nav-item${activeNav === r ? ' active' : ''}`} onClick={() => go(r)}>
              <span className="ico">{ICON[r]}</span>{t(`nav.${r}`)}
            </button>
          ))}
          <SearchBox className="side" placeholder={t('searchLibrary')} value={librarySearch} onChange={setLibrarySearch} clearLabel={t('search.clear')} />
          <div className="side-games">
            {libEntries.filter((g) => !librarySearch || g.title.toLowerCase().includes(librarySearch.toLowerCase())).map((g) => (
              <button key={g.id} className={`nav-item small${gameId === `lib:${g.id}` && route === 'game' ? ' active' : ''}${g.missing ? ' dim' : ''}`} onClick={() => go('game', `lib:${g.id}`)} onContextMenu={onEntryContext(g.id)}>
                <Cover className="side-thumb" gameId={g.gameId ?? 0} title={g.title} />
                <span className="side-name">{g.title}</span>
              </button>
            ))}
          </div>
        </nav>
        <main className="main">
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
      <div className="statusbar">{t('footer.noJob')}</div>
    </div>
  )
}
