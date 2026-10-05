import { confirmDialog } from '@/ui/AskDialog'
import { useEffect, useState, type DragEvent } from 'react'
import type { ProviderStatus } from '@shared/catalog'
import type { UpdateChangelog } from '@shared/ipc'
import type { SourceListSummary } from '@shared/sourceList'
import { t } from '@/i18n'
import { Button } from '@/ui'
import { Modal } from '@/ui/CollectionDialogs'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import { useUpdate } from '@/store/update'
import { useChangelog } from '@/store/changelog'
import { useEmulators } from '@/store/emulators'
import { ACCENTS, UI_SCALES, type Accent, type LanguageSetting, type ThemeSetting } from '@shared/settings'
import { formatSize } from '@shared/format'
import { AppearanceAdvanced } from '@/ui/AppearanceAdvanced'
import { LaunchersSection } from '@/ui/LaunchersSection'
import { LanguageFiles } from '@/ui/LanguageFiles'
import { HomeLayoutEditor } from '@/ui/HomeLayoutEditor'

const SECTIONS = ['general', 'appearance', 'emulation', 'sources', 'launchers', 'about', 'danger'] as const
type Section = (typeof SECTIONS)[number]

const isSection = (s: string | undefined): s is Section => (SECTIONS as readonly string[]).includes(s ?? '')

export function Settings() {
  // `gameId` sert de section de départ pour cette route (ex. venant du badge de mise à jour → « À propos »).
  const requestedSection = useApp((s) => s.gameId)
  const [section, setSection] = useState<Section>(isSection(requestedSection) ? requestedSection : 'general')
  const { settings, info, update, languages } = useSettings()
  const [restart, setRestart] = useState(false)
  const [cacheMsg, setCacheMsg] = useState<string | null>(null)
  const [clearingCache, setClearingCache] = useState(false)
  const [cacheBytes, setCacheBytes] = useState<number | null>(null)
  const refreshCacheSize = (): void => void window.api.invoke('cache:size').then(setCacheBytes)

  const upd = useUpdate((s) => s.state)
  const [lastChangelog, setLastChangelog] = useState<UpdateChangelog>(null)
  useEffect(() => {
    if (section !== 'about') return
    void window.api.invoke('update:lastChangelog').then(setLastChangelog)
  }, [section])
  useEffect(() => {
    if (section !== 'general') return
    refreshCacheSize()
  }, [section])
  const updateLabel = upd.status === 'idle' ? t('update.idle')
    : upd.status === 'error' ? t('update.error', { error: upd.error ?? '' })
    : t(`update.${upd.status}`, { version: upd.version ?? '', percent: upd.percent })

  const chooseDir = async (): Promise<void> => {
    const r = await window.api.invoke('paths:chooseDataDir')
    if (r?.restartRequired) setRestart(true)
  }

  const clearCache = async (): Promise<void> => {
    setClearingCache(true)
    setCacheMsg(null)
    try {
      const r = await window.api.invoke('cache:clear')
      setCacheMsg(r.freedBytes > 0
        ? t('settings.clearCacheDone', { size: formatSize(r.freedBytes) })
        : t('settings.clearCacheEmpty'))
      refreshCacheSize()
    } finally {
      setClearingCache(false)
    }
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
            <h3>{t('settings.groupApp')}</h3>
            <label className="field">
              {t('settings.language')}
              <select value={settings.language} onChange={(e) => update({ language: e.target.value as LanguageSetting })}>
                <option value="auto">{t('settings.langAuto')}</option>
                {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </label>
            <LanguageFiles />
            <label className="check">
              <input type="checkbox" checked={settings.startInBigPicture} onChange={(e) => update({ startInBigPicture: e.target.checked })} /> {t('settings.startBigPicture')}
            </label>
            <p className="muted">{t('settings.startBigPictureHint')}</p>

            <h3>{t('settings.groupImport')}</h3>
            <label className="check">
              <input type="checkbox" checked={settings.importCopy} onChange={(e) => update({ importCopy: e.target.checked })} /> {t('settings.importCopy')}
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.importDeleteSource} onChange={(e) => update({ importDeleteSource: e.target.checked })} /> {t('settings.importDeleteSource')}
            </label>
            <div className="field" style={{ marginTop: 16 }}>
              {t('settings.scanFolders')}
              <p className="muted">{t('settings.scanHint')}</p>
              {settings.scanFolders.map((f) => (
                <div key={f} className="row"><span style={{ flex: 1, wordBreak: 'break-all' }}>{f}</span><Button onClick={() => void update({ scanFolders: settings.scanFolders.filter((x) => x !== f) })}>✕</Button></div>
              ))}
              <div><Button onClick={async () => { const p = await window.api.invoke('library:pick', 'folder'); if (p.length) await update({ scanFolders: [...settings.scanFolders, ...p] }) }}>+ {t('settings.addFolder')}</Button></div>
            </div>

            <h3>{t('settings.groupData')}</h3>
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
            <div className="field">
              {t('settings.clearCache')}
              {cacheBytes !== null && <p className="muted">{t('settings.cacheSize', { size: formatSize(cacheBytes) })}</p>}
              <div className="row">
                <Button disabled={clearingCache} onClick={() => void clearCache()}>{t('settings.clearCache')}</Button>
                {cacheMsg && <span className="muted">{cacheMsg}</span>}
              </div>
              <p className="muted">{t('settings.clearCacheHint')}</p>
            </div>
          </>
        )}

        {section === 'emulation' && (
          <>
            <h3>{t('settings.groupSaves')}</h3>
            <label className="check">
              <input type="checkbox" checked={settings.autoBackupSaves} onChange={(e) => update({ autoBackupSaves: e.target.checked })} /> {t('settings.autoBackup')}
            </label>
            <p className="muted">{t('settings.autoBackupHint')}</p>
            <h3>{t('settings.groupController')}</h3>
            <ControllerSection />
          </>
        )}

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
            <AppearanceAdvanced />
            <HomeLayoutEditor />
          </>
        )}

        {section === 'launchers' && <LaunchersSection />}

        {section === 'sources' && (
          <>
            <SourcesSection />
            <h3>{t('settings.groupAccounts')}</h3>
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
            <p className="muted">Kartouche v{info.version} · SQLite {info.sqlite}</p>
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
  const [sourceCount, setSourceCount] = useState(0)
  useEffect(() => { void window.api.invoke('sourceLists:list').then((l) => setSourceCount(l.length)) }, [])

  const run = async (confirmText: string, job: () => Promise<void>): Promise<void> => {
    if (!await confirmDialog(confirmText)) return
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
          <div><strong>{t('danger.removeAllSources')}</strong><p className="muted">{t('danger.removeAllSourcesHint')}</p></div>
          {sourceCount === 0
            ? <span className="muted">{t('danger.removeAllSourcesNone')}</span>
            : <Button variant="danger" disabled={busy} onClick={() => void run(t('danger.removeAllSourcesConfirm', { n: sourceCount }), async () => { await window.api.invoke('sourceLists:removeAll'); setSourceCount(0) })}>{t('danger.removeAllSources')}</Button>}
        </div>
        <div className="danger-row">
          <div><strong>{t('danger.factoryReset')}</strong><p className="muted">{t('danger.factoryResetHint')}</p></div>
          <Button variant="danger" disabled={busy} onClick={() => void run(t('danger.factoryResetConfirm'), () => window.api.invoke('app:factoryReset'))}>{t('danger.factoryReset')}</Button>
        </div>
      </div>
    </>
  )
}

/** Exemple du format `kartouche.sourcelist/v1`, valeurs volontairement fictives — voir src/shared/sourceList.ts. */
const SOURCE_FORMAT_EXAMPLE = `{
  "schemaVersion": 1,
  "name": "My personal list",
  "homepage": "https://example.com",
  "generatedAt": "2026-01-01T00:00:00Z",
  "entries": [
    {
      "title": "Sample Game (Demo)",
      "console": "snes",
      "uris": ["https://example.com/files/sample-game-demo.zip"],
      "sizeBytes": 524288,
      "hash": { "crc32": "00000000", "sha1": "0000000000000000000000000000000000000000" },
      "note": "Personal dump"
    }
  ]
}`

/** Popup d'aide au format JSON attendu, ouverte depuis le bouton ⓘ à côté de l'intro de la section. */
function SourceFormatDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t('sources.formatTitle')} onClose={onClose}>
      <p className="muted">{t('sources.formatIntro')}</p>
      <p className="muted">{t('sources.formatFields')}</p>
      <p className="muted">{t('sources.formatExampleLabel')}</p>
      <pre className="modal-list source-format-example">{SOURCE_FORMAT_EXAMPLE}</pre>
      <div className="row modal-actions"><Button variant="primary" onClick={onClose}>{t('dialog.close')}</Button></div>
    </Modal>
  )
}

/**
 * Listes de sources apportées par l'utilisateur (v0.2.0). Kartouche n'en fournit, n'en scrape ni
 * n'en agrège aucune : chaque liste vient d'une URL ou d'un fichier JSON local que l'utilisateur choisit lui-même.
 */
function SourcesSection() {
  const [showFormatInfo, setShowFormatInfo] = useState(false)
  const [lists, setLists] = useState<SourceListSummary[]>([])
  const [url, setUrl] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | 'add' | 'all' | null>(null)
  const [over, setOver] = useState(false)
  const [allReport, setAllReport] = useState<string[] | null>(null)

  const refresh = async (): Promise<void> => setLists(await window.api.invoke('sourceLists:list'))
  useEffect(() => { void refresh() }, [])

  const add = async (value?: string): Promise<void> => {
    const v = (value ?? url).trim()
    if (!v) return
    setBusyId('add')
    setAddError(null)
    try {
      await window.api.invoke('sourceLists:add', v)
      setUrl('')
      await refresh()
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const browse = async (): Promise<void> => {
    const path = await window.api.invoke('sourceLists:pick')
    if (path) await add(path)
  }

  const onDrop = async (e: DragEvent): Promise<void> => {
    e.preventDefault()
    setOver(false)
    for (const p of [...e.dataTransfer.files].map((f) => window.api.pathOf(f)).filter(Boolean)) await add(p)
  }

  const refreshOne = async (id: number): Promise<void> => {
    setBusyId(id)
    try { await window.api.invoke('sourceLists:refresh', id) } finally { setBusyId(null); await refresh() }
  }

  const refreshAll = async (): Promise<void> => {
    setBusyId('all'); setAllReport(null)
    try {
      const r = await window.api.invoke('sourceLists:refreshAll')
      setAllReport([t('sources.refreshAllDone', { n: r.refreshed }), ...r.failed.map((f) => t('sources.refreshAllFailed', { name: f.name, e: f.error }))])
    } finally { setBusyId(null); await refresh() }
  }

  const remove = async (list: SourceListSummary): Promise<void> => {
    if (!await confirmDialog(t('sources.removeConfirm', { n: list.entryCount }))) return
    setBusyId(list.id)
    try { await window.api.invoke('sourceLists:remove', list.id) } finally { setBusyId(null); await refresh() }
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <p className="muted">{t('sources.hint')}</p>
        <span className="bios-info" role="button" tabIndex={0} title={t('sources.formatInfo')} aria-label={t('sources.formatInfo')} onClick={() => setShowFormatInfo(true)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowFormatInfo(true) } }}>i</span>
      </div>
      {showFormatInfo && <SourceFormatDialog onClose={() => setShowFormatInfo(false)} />}
      <div className={`field dropzone${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false) }} onDrop={(e) => void onDrop(e)}>
        <div className="row">
          <input style={{ flex: 1 }} placeholder={t('sources.urlPlaceholder')} value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
          <Button onClick={() => void browse()}>{t('sources.browse')}</Button>
          <Button variant="primary" disabled={busyId === 'add' || !url.trim()} onClick={() => void add()}>{t('sources.add')}</Button>
        </div>
        <p className="muted">{t('sources.dropHint')}</p>
      </div>
      {addError && <p className="notice">{addError}</p>}

      {lists.length === 0 && <p className="muted">{t('sources.empty')}</p>}
      {lists.length > 0 && (
        <div className="row" style={{ margin: '8px 0', justifyContent: 'flex-end' }}>
          <Button disabled={busyId !== null} onClick={() => void refreshAll()}>{busyId === 'all' ? t('sources.refreshingAll') : t('sources.refreshAll')}</Button>
        </div>
      )}
      {allReport && allReport.map((l, k) => <p key={k} className={k === 0 ? 'muted' : 'notice'}>{l}</p>)}
      {lists.map((l) => (
        <div key={l.id} className="danger-row">
          <div>
            <strong>{l.name}</strong>
            <p className="muted" title={l.localCopyPath ? t('sources.copyOf', { p: l.url }) : undefined}>{l.localCopyPath ?? l.url}</p>
            <p className="muted">
              {t('sources.matched', { matched: l.matchedCount, total: l.entryCount })}
              {' · '}
              {l.lastRefreshedAt ? t('sources.lastRefreshed', { date: new Date(l.lastRefreshedAt).toLocaleString() }) : t('sources.neverRefreshed')}
            </p>
            {l.error && <p className="notice">{l.error}</p>}
          </div>
          <div className="row">
            <Button disabled={busyId === l.id || busyId === 'all'} onClick={() => void refreshOne(l.id)}>{t('sources.refresh')}</Button>
            <Button variant="danger" disabled={busyId === l.id} onClick={() => void remove(l)}>{t('sources.remove')}</Button>
          </div>
        </div>
      ))}
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
