import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ProgressBar } from '@/ui'
import { t, getLang } from '@/i18n'
import { useLibrary } from '@/store/library'
import { useEmulators } from '@/store/emulators'
import { emulatorForConsole } from '@shared/emulators'
import type { LibraryContentItem, LibraryEntry } from '@shared/library'
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
        {info.backups.length > 1 && <Button onClick={() => { if (window.confirm(t('saves.confirmDeleteAll', { n: info.backups.length }))) void run(() => window.api.invoke('saves:deleteAllBackups', entry.id)) }}>{t('saves.deleteAll')}</Button>}
      </div>
      {info.backups.length === 0 ? <p className="muted">{t('saves.noCopies')}</p> : info.backups.map((b) => (
        <div key={b.name} className="row copy-row">
          <span style={{ flex: 1 }}>{fmtDate(b.at)} <span className="muted">· {fmtSize(b.size)}</span></span>
          <Button disabled={running} onClick={() => { if (window.confirm(t('saves.confirmRestore', { d: fmtDate(b.at) }))) void run(async () => { await window.api.invoke('saves:restore', { entryId: entry.id, name: b.name }) }, t('saves.restored')) }}>{t('saves.restore')}</Button>
          <Button onClick={() => { if (window.confirm(t('saves.confirmDelete', { d: fmtDate(b.at) }))) void run(() => window.api.invoke('saves:deleteBackup', { entryId: entry.id, name: b.name })) }}>{t('saves.delete')}</Button>
        </div>
      ))}
    </div>
  )
}

/**
 * Mises à jour/DLC Switch détectés par Title ID et rattachés à ce jeu (voir `switchContent.ts`, migration v11).
 * Eden (comme Yuzu) n'a pas de commande pour les installer : ça passe par son menu « File > Install Files to NAND… »,
 * donc on se contente d'ouvrir l'émulateur et de rappeler la manip plutôt que de prétendre l'automatiser.
 */
export function ContentPanel({ entry }: { entry: LibraryEntry }) {
  const [items, setItems] = useState<LibraryContentItem[] | null>(null)
  useEffect(() => { void window.api.invoke('library:content', entry.id).then(setItems) }, [entry.id])
  if (entry.console !== 'switch' || !items || items.length === 0) return null
  const def = emulatorForConsole(entry.console)
  return (
    <div className="panel">
      <h3>{t('content.title')}</h3>
      <p className="muted">{t('content.installHint', { name: def?.name ?? 'Eden' })}</p>
      {items.map((c) => (
        <div key={c.id} className="row copy-row">
          <span style={{ flex: 1 }}>{c.label} <span className="muted">· {t(`content.${c.kind}`)} · {fmtSize(c.size)}</span></span>
        </div>
      ))}
      <div className="row">
        <Button onClick={() => void window.api.invoke('emulators:open', { id: def?.id ?? 'eden', what: 'app' })}>{t('content.openEmulator', { name: def?.name ?? 'Eden' })}</Button>
        <Button onClick={() => void window.api.invoke('library:revealContent', entry.id)}>{t('content.reveal')}</Button>
      </div>
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
