import { useEffect, useState } from 'react'
import { Button } from '@/ui'
import { Modal } from './Modal'
import { t } from '@/i18n'
import { CONSOLES, MAKERS } from '@shared/consoles'
import { DEFAULT_CUSTOM_ARGS, type CustomEmulatorError } from '@shared/customEmulators'
import { extensionsForConsoles } from '@shared/library'
import { useCustomEmulators } from '@/store/customEmulators'

/** Ajout ou modification d'un émulateur personnalisé : exécutable, arguments, consoles et extensions, avec la commande qui sera lancée en exemple. */
export function CustomEmulatorDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const existing = useCustomEmulators((s) => s.list.find((e) => e.id === id))
  const refresh = useCustomEmulators((s) => s.refresh)
  const [name, setName] = useState(existing?.name ?? '')
  const [exe, setExe] = useState(existing?.exe ?? '')
  const [args, setArgs] = useState(existing?.args ?? DEFAULT_CUSTOM_ARGS)
  const [consoles, setConsoles] = useState<string[]>(existing?.consoles ?? [])
  const [exts, setExts] = useState((existing?.extensions ?? []).join(' '))
  const [error, setError] = useState<CustomEmulatorError | 'notFound' | null>(null)
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const extensions = exts.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
  const accepted = extensionsForConsoles(consoles)
  const sampleExt = extensions[0]?.replace(/^\./, '') ?? accepted[0] ?? 'rom'

  // Aperçu de la commande : ce qui serait lancé pour un fichier d'exemple (rien n'est lancé).
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.api.invoke('customEmulators:preview', { exe: exe || 'emulateur.exe', args, rom: `D:\\Jeux\\Mon jeu.${sampleExt}`, console: consoles[0] ?? '' }).then(setPreview)
    }, 150)
    return () => clearTimeout(timer)
  }, [exe, args, consoles, sampleExt])

  const toggle = (c: string): void => { setError(null); setConsoles((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c])) }
  const browse = async (): Promise<void> => { const p = await window.api.invoke('customEmulators:pickExe'); if (p) { setExe(p); setError(null); if (!name.trim()) setName(p.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')) } }
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.invoke('customEmulators:save', { id: id ?? undefined, name, exe, args, consoles, extensions })
      if (r.ok) { await refresh(); onClose() } else setError(r.error)
    } finally { setBusy(false) }
  }

  return (
    <Modal title={t(id ? 'emu.custom.editTitle' : 'emu.custom.addTitle')} onClose={onClose}>
      <div className="edit-body">
        <label className="field edit-field" style={{ maxWidth: 'none' }}>{t('emu.custom.f.name')}
          <input value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setError(null) }} />
          {error === 'name' && <span className="edit-error">{t('emu.custom.err.name')}</span>}
        </label>
        <div className="field edit-field" style={{ maxWidth: 'none' }}>
          <span>{t('emu.custom.f.exe')}</span>
          <div className="row">
            <input style={{ flex: 1 }} value={exe} onChange={(e) => { setExe(e.target.value); setError(null) }} aria-label={t('emu.custom.f.exe')} />
            <Button onClick={() => void browse()}>{t('emu.custom.browse')}</Button>
          </div>
          {error === 'exe' && <span className="edit-error">{t('emu.custom.err.exe')}</span>}
        </div>
        <label className="field edit-field" style={{ maxWidth: 'none' }}>{t('emu.custom.f.args')}
          <input value={args} onChange={(e) => { setArgs(e.target.value); setError(null) }} spellCheck={false} />
          <span className="muted edit-sub">{t('emu.custom.argsHint')}</span>
          {error === 'args' && <span className="edit-error">{t('emu.custom.err.args')}</span>}
        </label>
        <div className="field edit-field" style={{ maxWidth: 'none' }}>
          <span>{t('emu.custom.f.consoles')}</span>
          {MAKERS.map((m) => (
            <div key={m} className="chip-row" role="group" aria-label={m}>
              {CONSOLES.filter((c) => c.maker === m).map((c) => (
                <button key={c.id} type="button" className={`chip${consoles.includes(c.id) ? ' on' : ''}`} aria-pressed={consoles.includes(c.id)} onClick={() => toggle(c.id)}>{c.label}</button>
              ))}
            </div>
          ))}
          {error === 'consoles' && <span className="edit-error">{t('emu.custom.err.consoles')}</span>}
        </div>
        <label className="field edit-field" style={{ maxWidth: 'none' }}>{t('emu.custom.f.extensions')}
          <input value={exts} onChange={(e) => { setExts(e.target.value); setError(null) }} spellCheck={false} placeholder={accepted.map((x) => `.${x}`).join(' ')} />
          <span className="muted edit-sub">{t('emu.custom.extHint')}</span>
          {error === 'extensions' && <span className="edit-error">{t('emu.custom.err.extensions')}</span>}
        </label>
        <div className="field edit-field" style={{ maxWidth: 'none' }}>
          <span>{t('emu.custom.preview')}</span>
          <code className="cmd-preview">{preview}</code>
        </div>
        {error === 'notFound' && <p className="edit-error" role="alert">{t('emu.custom.err.notFound')}</p>}
      </div>
      <div className="row modal-actions">
        {id && <Button onClick={() => void window.api.invoke('customEmulators:open', id)}>{t('emu.custom.test')}</Button>}
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>{t('dialog.cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{t('edit.save')}</Button>
      </div>
    </Modal>
  )
}
