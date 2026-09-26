import { useEffect, useState } from 'react'
import type { ProviderStatus } from '@shared/catalog'
import type { UpdateState } from '@shared/ipc'
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
  useEffect(() => { if (section === 'apiKeys') void window.api.invoke('providers:status').then(setProviders) }, [section, settings.igdbClientId, settings.igdbClientSecret, settings.tgdbApiKey, settings.sgdbApiKey])
  const quota = (id: string): string | null => { const p = providers.find((x) => x.id === id); return p?.configured ? t('settings.quota', { used: p.usedToday, limit: p.dailyLimit }) : null }

  const [upd, setUpd] = useState<UpdateState | null>(null)
  useEffect(() => {
    if (section !== 'about') return
    void window.api.invoke('update:state').then(setUpd)
    return window.api.on('update:state', setUpd)
  }, [section])
  const updateLabel = !upd || upd.status === 'idle' ? t('update.idle')
    : upd.status === 'error' ? t('update.error', { error: upd.error ?? '' })
    : t(`update.${upd.status}`, { version: upd.version ?? '', percent: upd.percent })

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
            <label className="check">
              <input type="checkbox" checked={settings.startInBigPicture} onChange={(e) => update({ startInBigPicture: e.target.checked })} /> {t('settings.startBigPicture')}
            </label>
            <p className="muted">{t('settings.startBigPictureHint')}</p>
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
            <h3>{t('settings.scanFolders')}</h3>
            <p className="muted">{t('settings.scanHint')}</p>
            {settings.scanFolders.map((f) => (
              <div key={f} className="row"><span style={{ flex: 1, wordBreak: 'break-all' }}>{f}</span><Button onClick={() => void update({ scanFolders: settings.scanFolders.filter((x) => x !== f) })}>✕</Button></div>
            ))}
            <div><Button onClick={async () => { const p = await window.api.invoke('library:pick', 'folder'); if (p.length) await update({ scanFolders: [...settings.scanFolders, ...p] }) }}>+ {t('settings.addFolder')}</Button></div>
          </>
        )}

        {section === 'emulation' && (
          <>
            <label className="check">
              <input type="checkbox" checked={settings.autoBackupSaves} onChange={(e) => update({ autoBackupSaves: e.target.checked })} /> {t('settings.autoBackup')}
            </label>
            <p className="muted">{t('settings.autoBackupHint')}</p>
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
            <p className="muted">{quota('igdb')}</p>
            <label className="field">{t('settings.tgdbKey')}
              <input type="password" defaultValue={settings.tgdbApiKey} onBlur={(e) => update({ tgdbApiKey: e.target.value })} autoComplete="off" />
            </label>
            <p className="muted">{quota('tgdb')}</p>
            <label className="field">{t('settings.sgdbKey')}
              <input type="password" defaultValue={settings.sgdbApiKey} onBlur={(e) => update({ sgdbApiKey: e.target.value })} autoComplete="off" />
            </label>
            <p className="muted">{t('settings.raHint')}</p>
            <label className="field">{t('settings.raUser')}
              <input defaultValue={settings.raUsername} onBlur={(e) => update({ raUsername: e.target.value })} autoComplete="off" />
            </label>
            <label className="field">{t('settings.raKey')}
              <input type="password" defaultValue={settings.raApiKey} onBlur={(e) => update({ raApiKey: e.target.value })} autoComplete="off" />
            </label>
          </>
        )}

        {section === 'about' && info && (
          <>
            <p className="muted">RomVault v{info.version} · SQLite {info.sqlite}</p>
            <h3>{t('update.title')}</h3>
            <p className="muted">{updateLabel}</p>
            <div className="row">
              {(!upd || ['idle', 'none', 'error', 'unavailable'].includes(upd.status)) && <Button onClick={() => void window.api.invoke('update:check').then(setUpd)}>{t('update.check')}</Button>}
              {upd?.status === 'available' && <Button variant="primary" onClick={() => void window.api.invoke('update:download')}>{t('update.download')}</Button>}
              {upd?.status === 'ready' && <Button variant="primary" onClick={() => void window.api.invoke('update:install')}>{t('update.install')}</Button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
