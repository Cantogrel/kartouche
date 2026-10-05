import { useEffect, useState } from 'react'
import { Button } from '@/ui'
import { t } from '@/i18n'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import type { ConnectorStatus, ScanReport } from '@shared/connectors'

/** Paramètres → Launchers : active la lecture de chaque launcher installé (Steam, Epic…) et importe ses jeux dans la bibliothèque. */
export function LaunchersSection() {
  const [list, setList] = useState<ConnectorStatus[] | null>(null)
  const [reports, setReports] = useState<Record<string, ScanReport>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const refresh = (): void => void window.api.invoke('connectors:list').then(setList)
  useEffect(refresh, [])

  const scan = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const [r] = await window.api.invoke('connectors:scan', id)
      if (r) setReports((x) => ({ ...x, [id]: r }))
      await useLibrary.getState().refresh()
      refresh()
    } finally { setBusy(null) }
  }
  const toggle = async (c: ConnectorStatus): Promise<void> => {
    await window.api.invoke('connectors:setEnabled', { id: c.id, enabled: !c.enabled })
    await useSettings.getState().load()
    if (!c.enabled) await scan(c.id)
    else { await useLibrary.getState().refresh(); setReports((x) => { const { [c.id]: _gone, ...rest } = x; return rest }); refresh() }
  }
  const summary = (r: ScanReport): string => (r.ok
    ? t('launchers.report', { found: String(r.found), added: String(r.added), dup: String(r.duplicates) })
    : r.error === 'absent' ? t('launchers.absent') : t('launchers.error', { error: r.error ?? '' }))

  if (list === null) return null
  return (
    <>
      <p className="muted">{t('launchers.hint')}</p>
      {list.length === 0 && <p className="muted">{t('launchers.none')}</p>}
      {list.map((c) => (
        <div key={c.id} className="launcher-row">
          <label className="check">
            <input type="checkbox" checked={c.enabled} disabled={busy !== null || (!c.detected && !c.enabled)} onChange={() => void toggle(c)} />
            <strong>{c.name}</strong>
          </label>
          <span className="muted">{c.detected ? t('launchers.detected') : t('launchers.notDetected')}{c.games > 0 && ` · ${t('launchers.games', { n: String(c.games) })}`}</span>
          {c.enabled && <Button disabled={busy !== null} onClick={() => void scan(c.id)}>{busy === c.id ? t('launchers.scanning') : t('launchers.rescan')}</Button>}
          {reports[c.id] && <span className="muted launcher-report">{summary(reports[c.id])}</span>}
        </div>
      ))}
    </>
  )
}
