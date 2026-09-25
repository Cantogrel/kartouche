import { useEffect, useState } from 'react'
import { t, setLang } from '@/i18n'
import { useApp, type Route } from '@/store/app'
import { Library } from '@/pages/Library'

const NAV: Route[] = ['home', 'catalog', 'library', 'emulators', 'settings']

export default function App() {
  const { route, go } = useApp()
  const [, force] = useState(0)
  const [info, setInfo] = useState('')
  useEffect(() => {
    window.api.ping().then((r) => { setLang(r.locale); setInfo(`sqlite ${r.sqlite}`); force((n) => n + 1) })
  }, [])
  return (
    <div className="app">
      <div className="titlebar">
        <span>RomVault <small style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{info}</small></span>
        <div className="right">
          <button className="pill" style={{ height: 22, padding: '0 10px', marginRight: 12 }}>{t('bigpicture')}</button>
          <button onClick={() => window.api.window.minimize()}>–</button>
          <button onClick={() => window.api.window.maximize()}>▢</button>
          <button onClick={() => window.api.window.close()}>✕</button>
        </div>
      </div>
      <div className="body">
        <nav className="sidebar">
          {NAV.map((r) => (
            <button key={r} className={`nav-item${route === r ? ' active' : ''}`} onClick={() => go(r)}>{t(`nav.${r}`)}</button>
          ))}
        </nav>
        <main className="main">
          <div className="pagehead"><h1>{t(`nav.${route}`)}</h1><input className="search" placeholder={t('search')} /></div>
          {route === 'library' ? <Library /> : <div className="content"><p className="empty">{t(`nav.${route}`)}</p></div>}
        </main>
      </div>
    </div>
  )
}
