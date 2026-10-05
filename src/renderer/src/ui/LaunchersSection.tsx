import { useEffect, useState } from 'react'
import { Button } from '@/ui'
import { confirmDialog } from '@/ui/AskDialog'
import { t } from '@/i18n'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import type { ConnectorStatus, ScanReport } from '@shared/connectors'

/** Paramètres → Launchers : associe chaque launcher installé (Steam, Epic…) à Kartouche pour importer ses jeux dans la bibliothèque, ou le dissocie. */
export function LaunchersSection() {
  const [list, setList] = useState<ConnectorStatus[] | null>(null)
  const [reports, setReports] = useState<Record<string, ScanReport>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = (): void => void window.api.invoke('connectors:list', { detect: false }).then(setList)
  // Deux temps : la liste s'affiche tout de suite (dernière détection connue), puis la vraie détection (registre, fichiers) la complète.
  useEffect(() => {
    let off = false
    void window.api.invoke('connectors:list', { detect: false }).then((l) => { if (!off) setList(l) })
    void window.api.invoke('connectors:list', { detect: true }).then((l) => { if (!off) setList(l) })
    return () => { off = true }
  }, [])

  const scan = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const [r] = await window.api.invoke('connectors:scan', id)
      if (r) setReports((x) => ({ ...x, [id]: r }))
      await useLibrary.getState().refresh()
      refresh()
    } finally { setBusy(null) }
  }
  const link = async (c: ConnectorStatus): Promise<void> => {
    await window.api.invoke('connectors:setEnabled', { id: c.id, enabled: true })
    await useSettings.getState().load()
    await scan(c.id)
  }
  const unlink = async (c: ConnectorStatus): Promise<void> => {
    if (c.games > 0 && !(await confirmDialog(t('launchers.unlinkConfirm', { name: c.name, n: String(c.games) })))) return
    setBusy(c.id)
    try {
      await window.api.invoke('connectors:setEnabled', { id: c.id, enabled: false })
      await useSettings.getState().load()
      await useLibrary.getState().refresh()
      setReports((x) => { const { [c.id]: _gone, ...rest } = x; return rest })
      refresh()
    } finally { setBusy(null) }
  }
  const summary = (r: ScanReport): string => (r.ok
    ? t('launchers.report', { found: String(r.found), added: String(r.added), dup: String(r.duplicates) })
    : r.error === 'absent' ? t('launchers.absent') : t('launchers.error', { error: r.error ?? '' }))
  const state = (c: ConnectorStatus): string => (c.detected === null ? t('launchers.detecting') : c.detected ? t('launchers.detected') : t('launchers.notDetected'))

  if (list === null) return null
  return (
    <>
      <p className="muted">{t('launchers.hint')}</p>
      {list.length === 0 && <p className="muted">{t('launchers.none')}</p>}
      {list.map((c) => (
        <div key={c.id} className="launcher-row">
          <strong className="launcher-name">{c.name}</strong>
          <span className="muted launcher-state">{state(c)}{c.games > 0 && ` · ${t('launchers.games', { n: String(c.games) })}`}</span>
          <span className="launcher-scan">{c.enabled && <Button disabled={busy !== null} onClick={() => void scan(c.id)}>{busy === c.id ? t('launchers.scanning') : t('launchers.rescan')}</Button>}</span>
          <span className="launcher-link">
            {c.enabled
              ? <Button disabled={busy !== null} onClick={() => void unlink(c)}>{t('launchers.unlink')}</Button>
              : <Button variant="primary" disabled={busy !== null || c.detected !== true} onClick={() => void link(c)}>{t('launchers.link')}</Button>}
          </span>
          {reports[c.id] && <span className="muted launcher-report">{summary(reports[c.id])}</span>}
        </div>
      ))}
    </>
  )
}
