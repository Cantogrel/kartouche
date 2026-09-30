import { useEffect, useState } from 'react'
import type { ProviderStatus } from '@shared/catalog'
import type { UpdateChangelog } from '@shared/ipc'
import { t } from '@/i18n'
import { Button } from '@/ui'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import { useUpdate } from '@/store/update'
import { useChangelog } from '@/store/changelog'
import { useEmulators } from '@/store/emulators'
import { ACCENTS, UI_SCALES, type Accent, type LanguageSetting, type ThemeSetting } from '@shared/settings'

const SECTIONS = ['general', 'import', 'emulation', 'controller', 'appearance', 'apiKeys', 'about', 'danger'] as const
type Section = (typeof SECTIONS)[number]

const isSection = (s: string | undefined): s is Section => (SECTIONS as readonly string[]).includes(s ?? '')

export function Settings() {
  // `gameId` sert de section de départ pour cette route (ex. venant du badge de mise à jour → « À propos »).
  const requestedSection = useApp((s) => s.gameId)
  const [section, setSection] = useState<Section>(isSection(requestedSection) ? requestedSection : 'general')
  const { settings, info, update } = useSettings()
  const [restart, setRestart] = useState(false)

  const upd = useUpdate((s) => s.state)
  const [lastChangelog, setLastChangelog] = useState<UpdateChangelog>(null)
  useEffect(() => {
    if (section !== 'about') return
    void window.api.invoke('update:lastChangelog').then(setLastChangelog)
  }, [section])
  const updateLabel = upd.status === 'idle' ? t('update.idle')
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

        {section === 'controller' && <ControllerSection />}

        {section === 'appearance' && (
          <>
            <label className="field">
              {t('settings.theme')}
              <select value={settings.theme} onChange={(e) => void update({ theme: e.target.value as ThemeSetting })}>
                <option value="auto">{t('theme.auto')}</option>
                <option value="light">{t('theme.light')}</option>
                <option value="dark">{t('theme.dark')}</option>
              </select>
            </label>
            <div className="field">
              {t('settings.accent')}
              <div className="row" role="radiogroup" aria-label={t('settings.accent')}>
                {ACCENTS.map((a) => (
                  <button key={a} role="radio" aria-checked={settings.accent === a} aria-label={t(`accent.${a}`)} title={t(`accent.${a}`)} className={`swatch accent-${a}${settings.accent === a ? ' on' : ''}`} onClick={() => void update({ accent: a as Accent })} />
                ))}
              </div>
            </div>
            <label className="field">
              {t('settings.uiScale')}
              <select value={settings.uiScale} onChange={(e) => void update({ uiScale: Number(e.target.value) })}>
                {UI_SCALES.map((v) => <option key={v} value={v}>{Math.round(v * 100)} %</option>)}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => void update({ reduceMotion: e.target.checked })} /> {t('settings.reduceMotion')}
            </label>
            <p className="muted">{t('settings.reduceMotionHint')}</p>
          </>
        )}

        {section === 'apiKeys' && (
          <>
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
              {['idle', 'none', 'error', 'unavailable'].includes(upd.status) && <Button onClick={() => void useUpdate.getState().check()}>{t('update.check')}</Button>}
              {upd.status === 'available' && <Button variant="primary" onClick={() => void useUpdate.getState().download()}>{t('update.download')}</Button>}
              {upd.status === 'ready' && <Button variant="primary" onClick={() => useUpdate.getState().install()}>{t('update.install')}</Button>}
              {lastChangelog && <Button onClick={() => void useChangelog.getState().showLast()}>{t('update.viewChangelog', { v: lastChangelog.version })}</Button>}
            </div>
          </>
        )}

        {section === 'danger' && <DangerSection />}
      </div>
    </div>
  )
}

/**
 * Actions globales destructrices, regroupées à part pour ne pas se retrouver à côté des réglages courants.
 * Une seule à la fois (`busy`) pour éviter un double clic pendant qu'une opération tourne.
 */
function DangerSection() {
  const entries = useLibrary((s) => s.entries)
  const { clearAll, deleteAllFiles } = useLibrary()
  const emuList = useEmulators((s) => s.list)
  const { uninstallAll } = useEmulators()
  const installed = emuList.filter((e) => e.installed)
  const [busy, setBusy] = useState(false)
  const withFile = entries.filter((e) => !e.missing).length

  const run = async (confirmText: string, job: () => Promise<void>): Promise<void> => {
    if (!window.confirm(confirmText)) return
    setBusy(true)
    try { await job() } finally { setBusy(false) }
  }

  return (
    <>
      <p className="muted">{t('settings.dangerHint')}</p>
      <div className="danger-zone">
        <div className="danger-row">
          <div><strong>{t('danger.clearLibrary')}</strong><p className="muted">{t('danger.clearLibraryHint')}</p></div>
          {entries.length === 0
            ? <span className="muted">{t('danger.clearLibraryNone')}</span>
            : <Button variant="danger" disabled={busy} onClick={() => void run(t('danger.clearLibraryConfirm', { n: entries.length }), clearAll)}>{t('danger.clearLibrary')}</Button>}
        </div>
        <div className="danger-row">
          <div><strong>{t('danger.deleteAllFiles')}</strong><p className="muted">{t('danger.deleteAllFilesHint')}</p></div>
          {withFile === 0
            ? <span className="muted">{t('danger.deleteAllFilesNone')}</span>
            : <Button variant="danger" disabled={busy} onClick={() => void run(t('danger.deleteAllFilesConfirm', { n: withFile }), deleteAllFiles)}>{t('danger.deleteAllFiles')}</Button>}
        </div>
        <div className="danger-row">
          <div><strong>{t('danger.uninstallAllEmulators')}</strong><p className="muted">{t('danger.uninstallAllEmulatorsHint')}</p></div>
          {installed.length === 0
            ? <span className="muted">{t('danger.uninstallAllEmulatorsNone')}</span>
            : <Button variant="danger" disabled={busy} onClick={() => void run(t('danger.uninstallAllEmulatorsConfirm', { n: installed.length }), uninstallAll)}>{t('danger.uninstallAllEmulators')}</Button>}
        </div>
        <div className="danger-row">
          <div><strong>{t('danger.factoryReset')}</strong><p className="muted">{t('danger.factoryResetHint')}</p></div>
          <Button variant="danger" disabled={busy} onClick={() => void run(t('danger.factoryResetConfirm'), () => window.api.invoke('app:factoryReset'))}>{t('danger.factoryReset')}</Button>
        </div>
      </div>
    </>
  )
}

/** Manette : réglages du Big Picture + contrôle en direct des manettes détectées (API Gamepad, profil standard). */
function ControllerSection() {
  const { settings, update } = useSettings()
  const [pads, setPads] = useState<{ id: string; pressed: string[] }[]>([])
  useEffect(() => {
    const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', '↑', '↓', '←', '→']
    const timer = window.setInterval(() => {
      const list = [...navigator.getGamepads()].filter((p): p is Gamepad => !!p).map((p) => ({
        id: p.id.replace(/\s*\(.*$/, ''),
        pressed: [...p.buttons].flatMap((b, i) => (b.pressed ? [names[i] ?? String(i)] : []))
      }))
      setPads((old) => (JSON.stringify(old) === JSON.stringify(list) ? old : list))
    }, 150)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={settings.padSwapAB} onChange={(e) => void update({ padSwapAB: e.target.checked })} /> {t('settings.padSwap')}
      </label>
      <p className="muted">{t('settings.padSwapHint')}</p>
      <label className="field">
        {t('settings.padThreshold')}
        <input type="range" min={0.3} max={0.9} step={0.05} value={settings.padThreshold} onChange={(e) => void update({ padThreshold: Number(e.target.value) })} />
        <span className="muted">{t('settings.padThresholdHint')}</span>
      </label>
      <h3>{t('settings.padDetected')}</h3>
      {pads.length === 0 && <p className="muted">{t('settings.padNone')}</p>}
      {pads.map((p) => (
        <div key={p.id} className="copy-row">
          <strong>{p.id}</strong>
          <div className="muted">{p.pressed.length ? p.pressed.join(' + ') : t('settings.padIdle')}</div>
        </div>
      ))}
    </>
  )
}
