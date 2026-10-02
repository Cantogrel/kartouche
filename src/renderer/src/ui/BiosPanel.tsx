import { confirmDialog } from '@/ui/AskDialog'
import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { Button } from '@/ui'
import { t } from '@/i18n'
import { biosSlotsFor, type BiosImportResult, type BiosSlotStatus } from '@shared/bios'
import type { EmulatorProgress } from '@shared/emulators'

const icon = (s: BiosSlotStatus | undefined): string => (!s || s.state !== 'ok' ? '✗' : s.unverified ? '!' : '✓')

const describe = (r: BiosImportResult): string => {
  const name = r.path.split(/[\\/]/).pop() ?? r.path
  if (r.ok) return `${name} : ${t('bios.imported', { slot: t(`bios.slot.${r.slot}`) })}${r.label ? ` (${r.label})` : ''}${r.verified ? '' : ` — ${t('bios.unverified')}`}`
  if (r.error === 'notInstalled') return `${name} : ${t('bios.installFirst')}`
  if (r.error === 'failed') return `${name} : ${t('bios.failed')}${r.detail ? ` (${r.detail})` : ''}`
  return `${name} : ${t('bios.unknown')}`
}

/** BIOS / firmware d'un émulateur : ce qui manque, import par sélecteur ou glisser-déposer, validation. */
export function BiosPanel({ emulator, onChange }: { emulator: string; onChange?: () => void }) {
  const [status, setStatus] = useState<BiosSlotStatus[]>([])
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<string[]>([])
  const [over, setOver] = useState(false)
  const [prog, setProg] = useState<EmulatorProgress | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copyDetail = (id: string, detail: string): void => {
    void navigator.clipboard.writeText(detail).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 1500) }).catch(() => {})
  }
  const slots = biosSlotsFor(emulator).filter((s) => !s.hidden)
  const auto = slots.find((s) => s.auto)
  const autoStatus = auto && status.find((x) => x.id === auto.id)
  const load = useCallback(async () => setStatus(await window.api.invoke('bios:status')), [])
  useEffect(() => { void load() }, [load])

  const run = async (paths: string[]): Promise<void> => {
    if (!paths.length || busy) return
    setBusy(true)
    setMessages([])
    try {
      const res = await window.api.invoke('bios:import', { emulator, paths })
      setMessages(res.map(describe))
    } finally { setBusy(false); await load(); onChange?.() }
  }
  const autoInstall = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessages([])
    const off = window.api.on('emulators:progress', (p) => { if (p.id === emulator) setProg(p) })
    try {
      const r = await window.api.invoke('bios:auto', emulator)
      setMessages([r.ok ? t('bios.imported', { slot: t(`bios.slot.${r.slot}`) }) : `${t('bios.autoFailed')}${r.detail ? ` (${r.detail})` : ''}`])
    } finally { off(); setProg(null); setBusy(false); await load(); onChange?.() }
  }
  const remove = async (id: string): Promise<void> => {
    if (busy || !await confirmDialog(t('bios.confirmRemove', { slot: t(`bios.slot.${id}`) }))) return
    setBusy(true)
    setMessages([])
    try { await window.api.invoke('bios:remove', id) } finally { setBusy(false); await load(); onChange?.() }
  }
  const pick = async (): Promise<void> => run(await window.api.invoke('bios:pick', emulator))
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    void run(Array.from(e.dataTransfer.files).map((f) => window.api.pathOf(f)).filter(Boolean))
  }
  const missing = slots.some((s) => status.find((x) => x.id === s.id)?.state !== 'ok')
  if (!slots.length) return null
  return (
    <div className={`bios-panel${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <div className="muted"><b>{t('bios.title')}</b>{missing ? ` — ${t('bios.hint')}` : ''}</div>
      <ul className="bios-list">
        {slots.map((s) => {
          const st = status.find((x) => x.id === s.id)
          const detail = t(`bios.slot.${s.id}.detail`)
          return (
            <li key={s.id} className={st?.state === 'ok' ? (st.unverified ? 'warn' : 'ok') : s.required ? 'bad' : ''}>
              <span className="bios-mark">{icon(st)}</span> {t(`bios.slot.${s.id}`)}{s.required ? '' : ` (${t('bios.optional')})`}{' '}
              <span
                className={`bios-info${copiedId === s.id ? ' copied' : ''}`}
                role="button"
                tabIndex={0}
                title={copiedId === s.id ? t('play.copied') : detail}
                aria-label={detail}
                onClick={() => copyDetail(s.id, detail)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyDetail(s.id, detail) } }}
              >{copiedId === s.id ? '✓' : 'i'}</span>
              {copiedId === s.id && <span className="muted bios-copied">{t('play.copied')}</span>}
              {st?.state === 'ok' && st.detail ? <span className="muted"> · {st.detail}</span> : null}
              {st?.state === 'ok' && st.source === 'emulator' ? <span className="muted"> · {t('bios.external')}</span> : null}
              {st?.state === 'ok' && st.unverified ? <span className="muted"> · {t('bios.unverified')}</span> : null}
              {st?.state === 'unavailable' ? <span className="muted"> · {t('bios.installFirst')}</span> : null}
              {st?.state === 'ok' && st.source !== 'emulator' && <button className="bios-remove" onClick={() => void remove(s.id)} disabled={busy}>{t('bios.remove')}</button>}
            </li>
          )
        })}
      </ul>
      {(missing || busy) && <div className="row">
        {auto && autoStatus && autoStatus.state !== 'ok' && (
          <Button variant="primary" onClick={() => void autoInstall()} disabled={busy || autoStatus.state === 'unavailable'}>{t('bios.auto')}</Button>
        )}
        {missing && <Button onClick={() => void pick()} disabled={busy}>{busy && !prog ? t('bios.importing') : t('bios.import')}</Button>}
      </div>}
      {prog && <div className="muted">{prog.phase === 'download' ? t('bios.downloading', { done: (prog.done / 1048576).toFixed(0), total: prog.total ? (prog.total / 1048576).toFixed(0) : '?' }) : prog.phase === 'firmware' ? t('bios.installing') : t('emu.resolving')}</div>}
      {messages.map((m, i) => <div key={i} className="muted">{m}</div>)}
    </div>
  )
}
