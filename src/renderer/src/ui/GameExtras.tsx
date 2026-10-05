import { confirmDialog } from '@/ui/AskDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ProgressBar } from '@/ui'
import { t, getLang } from '@/i18n'
import { useLibrary } from '@/store/library'
import { useEmulators } from '@/store/emulators'
import { emulatorForConsole } from '@shared/emulators'
import { CONTENT_CONSOLES, type LibraryContentItem, type LibraryEntry } from '@shared/library'
import type { AchievementsResult } from '@shared/achievements'
import type { SaveInfo } from '@shared/saves'

const fmtDate = (ms: number): string => new Date(ms).toLocaleString(getLang(), { dateStyle: 'medium', timeStyle: 'short' })
const fmtSize = (b: number): string => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

/** Favori et épingle d'un jeu de la bibliothèque (boutons de la fiche). */
export function FlagButtons({ entry }: { entry: LibraryEntry }) {
  const setFlag = useLibrary((s) => s.setFlag)
  return (
    <>
      <Button variant="icon" aria-pressed={entry.favorite} title={t(entry.favorite ? 'fav.remove' : 'fav.add')} aria-label={t('favorite')} onClick={() => void setFlag(entry.id, { favorite: !entry.favorite })}>{entry.favorite ? '♥' : '♡'}</Button>
      <Button variant="icon" aria-pressed={entry.pinned} title={t(entry.pinned ? 'pin.remove' : 'pin.add')} aria-label={t('pin')} onClick={() => void setFlag(entry.id, { pinned: !entry.pinned })}>{entry.pinned ? '★' : '☆'}</Button>
    </>
  )
}

/**
 * Bouton « Désinstaller » mis en avant sur la fiche (en plus de l'action équivalente dans le menu Options) : une
 * liste de sources permet de retélécharger ce jeu, donc supprimer son fichier n'est pas un aller simple comme pour
 * une ROM importée à la main — ça mérite un accès direct plutôt que d'être caché dans un menu.
 */
export function UninstallButton({ entry }: { entry: LibraryEntry }) {
  const removeEntry = useLibrary((s) => s.removeEntry)
  return (
    <Button onClick={async () => { if (await confirmDialog(t('confirm.uninstall', { title: entry.shownTitle }))) void removeEntry(entry.id, 'file') }}>
      {t('action.uninstall')}
    </Button>
  )
}

/** Sauvegardes du jeu : ce que l'émulateur a écrit, copies de sécurité (auto après chaque partie ou à la demande) et restauration. */
export function SavesPanel({ entry }: { entry: LibraryEntry }) {
  const running = useEmulators((s) => s.running.includes(entry.id))
  const savesRev = useLibrary((s) => s.savesRev)
  const [info, setInfo] = useState<SaveInfo | null | undefined>(undefined)
  const [message, setMessage] = useState<string | null>(null)
  const load = useCallback(async (): Promise<void> => { setInfo(await window.api.invoke('saves:info', entry.id)) }, [entry.id])
  // Rechargé à l'ouverture, puis à chaque fin de partie (les fichiers viennent de changer, et la copie automatique est en cours).
  const wasRunning = useRef(running)
  useEffect(() => { void load() }, [load, savesRev])
  useEffect(() => {
    if (wasRunning.current && !running) { const h = setTimeout(() => void load(), 2500); wasRunning.current = running; return () => clearTimeout(h) }
    wasRunning.current = running
    return undefined
  }, [running, load])
  if (!info) return null
  const def = emulatorForConsole(entry.console)
  const run = async (job: () => Promise<unknown>, done?: string): Promise<void> => { setMessage(null); await job(); await load(); if (done) setMessage(done) }
  return (
    <div className="panel">
      <h3>{t('saves.title')}</h3>
      <p className="muted">{info.scope === 'game' ? t('saves.gameScope') : t('saves.emulatorScope', { name: def?.name ?? info.emulator })}</p>
      {info.location && <p className="muted save-path" title={info.location}>{t('saves.location', { p: info.location })}</p>}
      <p>{info.files === 0 ? t('saves.none') : `${(info.files === 1 ? t('saves.file') : t('saves.files', { n: info.files }))}${info.modified ? ` · ${t('saves.modified', { d: fmtDate(info.modified) })}` : ''}`}</p>
      <div className="row">
        <Button disabled={info.files === 0} onClick={() => void run(() => window.api.invoke('saves:backup', entry.id))}>{t('saves.backup')}</Button>
        <Button onClick={() => void window.api.invoke('saves:open', entry.id)}>{t('saves.open')}</Button>
        {message && <span className="muted">{message}</span>}
        {running && info.backups.length > 0 && <span className="muted">{t('saves.closeFirst')}</span>}
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h4>{t('saves.copies')}</h4>
        {info.backups.length > 1 && <Button onClick={async () => { if (await confirmDialog(t('saves.confirmDeleteAll', { n: info.backups.length }))) void run(() => window.api.invoke('saves:deleteAllBackups', entry.id)) }}>{t('saves.deleteAll')}</Button>}
      </div>
      {info.backups.length === 0 ? <p className="muted">{t('saves.noCopies')}</p> : info.backups.map((b) => (
        <div key={b.name} className="row copy-row">
          <span style={{ flex: 1 }}>{fmtDate(b.at)} <span className="muted">· {fmtSize(b.size)}</span></span>
          <Button disabled={running} onClick={async () => { if (await confirmDialog(t('saves.confirmRestore', { d: fmtDate(b.at) }))) void run(async () => { await window.api.invoke('saves:restore', { entryId: entry.id, name: b.name }) }, t('saves.restored')) }}>{t('saves.restore')}</Button>
          <Button onClick={async () => { if (await confirmDialog(t('saves.confirmDelete', { d: fmtDate(b.at) }))) void run(() => window.api.invoke('saves:deleteBackup', { entryId: entry.id, name: b.name })) }}>{t('saves.delete')}</Button>
        </div>
      ))}
    </div>
  )
}

/**
 * Mises à jour et DLC rattachés à ce jeu (voir `library/content/`) : jamais des jeux à part, et rien à installer à la main — Kartouche les rend visibles de
 * l'émulateur tout seul. L'état dit où ils en sont (installé, en attente d'un lancement ou d'une clé, pas encore pris en charge).
 */
function ContentState({ c }: { c: LibraryContentItem }) {
  const key = c.state === 'installed' ? 'content.state.installed' : c.state === 'failed' ? 'content.state.failed' : `content.state.${c.reason ?? 'onLaunch'}`
  return <span className={c.state === 'installed' ? 'muted' : undefined} style={c.state === 'installed' ? undefined : { color: '#d29922' }} title={c.detail ?? undefined}>{t(key)}</span>
}

export function ContentPanel({ entry }: { entry: LibraryEntry }) {
  const [items, setItems] = useState<LibraryContentItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [report, setReport] = useState<{ lines: string[]; ok: boolean } | null>(null)
  const load = useCallback(async (): Promise<void> => { setItems(await window.api.invoke('library:content', entry.id)) }, [entry.id])
  // Rechargé aussi quand le jeu passe « sans fichier » (désinstallation du jeu : ses contenus partent avec lui) ou revient (réimport).
  useEffect(() => { void load() }, [load, entry.path, entry.missing])
  const supported = CONTENT_CONSOLES.includes(entry.console) && !entry.missing
  if (!items || (items.length === 0 && !supported)) return null

  const importFiles = async (paths: string[]): Promise<void> => {
    if (!paths.length || busy) return
    setBusy(t('content.importing')); setReport(null)
    const off = window.api.on('library:progress', (p) => setBusy(`${t('content.importing')} ${p.current}`.trim()))
    try {
      const res = await window.api.invoke('library:importContent', { entryId: entry.id, paths })
      const added = res.items.filter((i) => i.status === 'attached').length
      const dup = res.items.filter((i) => i.status === 'duplicate').length
      const refused = res.items.filter((i) => i.status !== 'attached' && i.status !== 'duplicate')
      const lines = [
        ...(added ? [t('content.imported', { n: added })] : []),
        ...(dup ? [t('content.duplicate', { n: dup })] : []),
        ...refused.map((i) => t('content.refused', { file: i.file.split(/[\\/]/).pop() ?? i.file, e: i.error ?? t('content.notContent') }))
      ]
      setReport({ lines, ok: refused.length === 0 })
      await load()
    } finally { off(); setBusy(null) }
  }
  const pick = async (kind: 'content' | 'folder'): Promise<void> => { await importFiles(await window.api.invoke('library:pick', kind)) }
  const remove = async (c: LibraryContentItem): Promise<void> => {
    if (busy || !(await confirmDialog(t('content.confirmUninstall', { name: c.label })))) return
    setBusy(t('content.uninstalling')); setReport(null)
    try {
      const r = await window.api.invoke('library:removeContent', c.id)
      if (!r.ok) setReport({ lines: [t('content.uninstallFailed', { name: c.label, e: r.error ?? '' })], ok: false })
      else if (r.leftover) setReport({ lines: [t('content.leftover', { name: emulatorForConsole(entry.console)?.name ?? r.leftover })], ok: false })
      await load()
    } finally { setBusy(null) }
  }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault(); e.stopPropagation(); setOver(false)
    void importFiles([...e.dataTransfer.files].map((f) => window.api.pathOf(f)).filter(Boolean))
  }
  return (
    <div className={`panel${over ? ' dropzone over' : ''}`} onDragOver={supported ? (e) => { e.preventDefault(); e.stopPropagation(); setOver(true) } : undefined}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false) }} onDrop={supported ? onDrop : undefined}>
      <h3>{t('content.title')}</h3>
      {items.length === 0 && <p className="muted">{t('content.none')}</p>}
      {(['update', 'dlc'] as const).map((kind) => {
        const list = items.filter((c) => c.kind === kind)
        return list.length === 0 ? null : (
          <div key={kind}>
            <div className="muted" style={{ margin: '8px 0 4px' }}>{t(kind === 'update' ? 'content.updates' : 'content.dlcs')}</div>
            {list.map((c) => (
              <div key={c.id} className="row copy-row">
                <span style={{ flex: 1 }}>{c.label}{c.version && <span className="muted"> · v{c.version}</span>} <span className="muted">· {fmtSize(c.size)}</span></span>
                <ContentState c={c} />
                <Button disabled={busy !== null} onClick={() => void remove(c)}>{t('content.uninstall')}</Button>
              </div>
            ))}
          </div>
        )
      })}
      <div className="row" style={{ marginTop: 8 }}>
        {supported && <Button disabled={busy !== null} onClick={() => void pick('content')}>{t('content.import')}</Button>}
        {supported && entry.console === 'wiiu' && <Button disabled={busy !== null} onClick={() => void pick('folder')}>{t('content.importFolder')}</Button>}
        {items.length > 0 && <Button onClick={() => void window.api.invoke('library:revealContent', entry.id)}>{t('content.reveal')}</Button>}
        {busy && <span className="muted">{busy}</span>}
      </div>
      {supported && !busy && <p className="muted">{t('content.dropHint')}</p>}
      {report && report.lines.map((l, k) => <p key={k} className={report.ok ? 'muted' : undefined} style={report.ok ? undefined : { color: '#d29922' }}>{l}</p>)}
    </div>
  )
}

const badgeUrl = (badge: string, locked: boolean): string => `https://media.retroachievements.org/Badge/${badge}${locked ? '_lock' : ''}.png`

/** Succès RetroAchievements du jeu (rapprochés par titre), actualisés après chaque partie. */
export function AchievementsPanel({ entry }: { entry: LibraryEntry }) {
  const running = useEmulators((s) => s.running.includes(entry.id))
  const [res, setRes] = useState<AchievementsResult | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async (refresh: boolean): Promise<void> => {
    setBusy(true)
    try { setRes(await window.api.invoke('achievements:get', { entryId: entry.id, refresh })) } finally { setBusy(false) }
  }, [entry.id])
  const wasRunning = useRef(running)
  useEffect(() => { setRes(null); void load(false) }, [load])
  useEffect(() => {
    if (wasRunning.current && !running) void load(true)
    wasRunning.current = running
  }, [running, load])
  if (res?.status === 'unsupported') return null
  const key = res?.status === 'noKey'
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{t('ach.title')}</h3>
        {res?.status === 'ok' && <Button disabled={busy} onClick={() => void load(true)}>{t('ach.refresh')}</Button>}
      </div>
      {!res && <span className="skeleton" style={{ width: '60%' }} />}
      {key && <p className="muted">{t('ach.noKey')}</p>}
      {res?.status === 'noMatch' && <p className="muted">{t('ach.noMatch')}</p>}
      {res?.status === 'error' && <p className="muted">{res.error === 'auth' ? t('ach.auth') : t('ach.error', { e: res.error })}</p>}
      {res?.status === 'ok' && (
        <>
          <p>{t('ach.progress', { e: res.data.earned, n: res.data.total, ep: res.data.earnedPoints, p: res.data.points })}</p>
          <ProgressBar value={res.data.total ? (res.data.earned / res.data.total) * 100 : 0} />
          <div className="ach-list">
            {res.data.achievements.map((a) => (
              <div key={a.id} className={`ach${a.earnedAt === null ? ' locked' : ''}`}>
                <img src={badgeUrl(a.badge, a.earnedAt === null)} alt="" loading="lazy" />
                <div>
                  <strong>{a.title}</strong> <span className="muted">· {a.points} pts{a.hardcore ? ` · ${t('ach.hardcore')}` : ''}</span>
                  <div className="muted">{a.description}</div>
                  <div className="muted">{a.earnedAt === null ? t('ach.locked') : t('ach.earned', { d: fmtDate(a.earnedAt) })}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
