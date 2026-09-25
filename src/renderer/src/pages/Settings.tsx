import { useEffect, useState } from 'react'
import type { ProviderStatus } from '@shared/catalog'
import { t } from '@/i18n'
import { Button } from '@/ui'
import { useSettings } from '@/store/settings'
import type { LanguageSetting } from '@shared/settings'

const SECTIONS = ['general', 'import', 'emulation', 'controller', 'appearance', 'apiKeys', 'about'] as const
type Section = (typeof SECTIONS)[number]

export function Settings() {
  const [section, setSection] = useState<Section>('general')
  const { settings, info, update } = useSettings()
  const [restart, setRestart] = useState(false)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  useEffect(() => { if (section === 'apiKeys') void window.api.invoke('providers:status').then(setProviders) }, [section, settings.igdbClientId, settings.igdbClientSecret])
  const igdb = providers.find((p) => p.id === 'igdb')

  const chooseDir = async (): Promise<void> => {
    const r = await window.api.invoke('paths:chooseDataDir')
    if (r?.restartRequired) setRestart(true)
  }

  return (
    <div className="content settings">
      <nav className="settings-nav">
        {SECTIONS.map((s) => (
          <button key={s} className={`nav-item${section === s ? ' active' : ''}`} onClick={() => setSection(s)}>{t(`settings.${s}`)}</button>
        ))}
      </nav>
      <div className="panel settings-body">
        <h2>{t(`settings.${section}`)}</h2>

        {section === 'general' && (
          <>
            <div className="field">
              {t('settings.dataFolder')}
              <div className="row">
                <input readOnly value={info?.paths.dataDir ?? ''} style={{ flex: 1 }} />
                <Button onClick={chooseDir}>{t('settings.change')}</Button>
                <Button onClick={() => window.api.invoke('paths:openDataDir')}>{t('settings.open')}</Button>
              </div>
              {restart && (
                <div className="row notice">
                  {t('settings.restartNeeded')}
                  <Button variant="primary" onClick={() => window.api.invoke('app:relaunch')}>{t('settings.restart')}</Button>
                </div>
              )}
            </div>
            <label className="field">
              {t('settings.language')}
              <select value={settings.language} onChange={(e) => update({ language: e.target.value as LanguageSetting })}>
                <option value="auto">{t('settings.langAuto')}</option>
                <option value="en">English</option>
                <option value="fr">Français</option>
              </select>
            </label>
          </>
        )}

        {section === 'import' && (
          <>
            <label className="check">
              <input type="checkbox" checked={settings.importCopy} onChange={(e) => update({ importCopy: e.target.checked })} /> {t('settings.importCopy')}
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.importDeleteSource} onChange={(e) => update({ importDeleteSource: e.target.checked })} /> {t('settings.importDeleteSource')}
            </label>
          </>
        )}

        {section === 'apiKeys' && (
          <>
            <p className="muted">{t('settings.igdbHint')}</p>
            <label className="field">{t('settings.igdbId')}
              <input defaultValue={settings.igdbClientId} onBlur={(e) => update({ igdbClientId: e.target.value })} autoComplete="off" />
            </label>
            <label className="field">{t('settings.igdbSecret')}
              <input type="password" defaultValue={settings.igdbClientSecret} onBlur={(e) => update({ igdbClientSecret: e.target.value })} autoComplete="off" />
            </label>
            {igdb?.configured && <p className="muted">{t('settings.quota', { used: igdb.usedToday, limit: igdb.dailyLimit })}</p>}
          </>
        )}

        {section === 'about' && info && (
          <p className="muted">RomVault v{info.version} · SQLite {info.sqlite}</p>
        )}
      </div>
    </div>
  )
}
