import { confirmDialog } from '@/ui/AskDialog'
import { useEffect } from 'react'
import { Button, ProgressBar, Section, Tag } from '@/ui'
import { t } from '@/i18n'
import { EMULATORS, MANUAL_PAD_EMULATORS, compareVersions, emulatorMaker, emulatorRank, type EmulatorDef } from '@shared/emulators'
import { CONSOLES, MAKERS } from '@shared/consoles'
import { extensionsForConsoles } from '@shared/library'
import { useEmulators } from '@/store/emulators'
import { BiosPanel } from '@/ui/BiosPanel'
import { biosSlotsFor } from '@shared/bios'
import { useCustomEmulators } from '@/store/customEmulators'
import { useDialog } from '@/ui/CollectionDialogs'
import { useSettings } from '@/store/settings'
import { platformLabel } from '@shared/consoles'

const consoleNames = (def: EmulatorDef): string => def.consoles.map((c) => CONSOLES.find((x) => x.id === c)?.label ?? c).join(', ')
const acceptedFiles = (def: EmulatorDef): string => extensionsForConsoles(def.consoles).map((x) => `.${x}`).join(' ')

const mb = (n: number): string => (n / 1048576).toFixed(n > 10485760 ? 0 : 1)

export function Emulators() {
  const { list, loaded, progress, errors, latest, checking, refresh, install, uninstall, locate, check } = useEmulators()
  useEffect(() => { void refresh() }, [refresh])
  const state = (id: string) => list.find((e) => e.id === id)
  const customs = useCustomEmulators((s) => s.list)
  const defaults = useSettings((s) => s.settings.emulatorDefaults)
  useEffect(() => { void useCustomEmulators.getState().refresh() }, [])
  const setDefault = async (console: string, id: string | null): Promise<void> => { await window.api.invoke('emulators:setDefault', { console, emulatorId: id }); await useSettings.getState().load() }
  return (
    <div className="content">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted">{t('emu.subtitle')}</p>
        <Button onClick={() => void check()} disabled={checking || !list.some((e) => e.installed && !e.custom)}>{checking ? t('emu.checking') : t('emu.checkUpdates')}</Button>
      </div>
      {MAKERS.map((maker) => (
      <Section key={maker} title={maker}>
      <div className="emu-grid">
        {EMULATORS.filter((d) => emulatorMaker(d) === maker).sort((a, b) => emulatorRank(a) - emulatorRank(b)).map((def) => {
          const s = state(def.id)
          const p = progress[def.id]
          const newer = latest[def.id]
          const update = !!s?.version && !!newer && newer !== s.version && (compareVersions(newer, s.version) > 0 || !/^[\d.]+$/.test(newer))
          const status = !loaded ? '' : p ? t('emu.installing') : !s?.installed ? t('status.notInstalled') : s.missing ? t('emu.missing') : update ? t('emu.updateAvailable', { v: newer ?? '' }) : t('status.installed')
          return (
            <div key={def.id} className="emu-card">
              <h3>{def.name}{MANUAL_PAD_EMULATORS.includes(def.id) && <span className="emu-warn" title={t('emu.manualPadHint')} aria-label={t('emu.manualPadHint')}>⚠</span>}</h3>
              <div className="muted">{consoleNames(def)}{s?.version ? ` · ${s.version}` : ''}{s?.custom ? ` · ${t('emu.custom')}` : ''}</div>
              <div className="muted emu-exts">{t('emu.acceptedFiles', { list: acceptedFiles(def) })}</div>
              {p && (
                <div style={{ marginTop: 12 }}>
                  <ProgressBar value={p.phase === 'download' && p.total ? (p.done / p.total) * 100 : p.phase === 'cores' && p.total ? (p.done / p.total) * 100 : 100} />
                  <div className="muted">
                    {p.phase === 'download' ? t('emu.downloading', { done: mb(p.done), total: p.total ? mb(p.total) : '?' }) : p.phase === 'extract' ? t('emu.extracting') : p.phase === 'cores' ? t('emu.cores', { name: p.message ?? '' }) : p.phase === 'firmware' ? t('bios.installing') : t('emu.resolving')}
                  </div>
                </div>
              )}
              {errors[def.id] && <div className="muted" style={{ color: 'var(--danger, #e5484d)', marginTop: 8 }}>{errors[def.id]}</div>}
              {/* Reclé sur installedAt : un (dés)install ailleurs sur la page ne notifie pas ce panneau autrement (coche verte qui reste
                  affichée après une désinstallation, jusqu'à un remontage — ex. changer d'onglet et revenir). */}
              {biosSlotsFor(def.id).length > 0 && <BiosPanel key={s?.installedAt ?? 'none'} emulator={def.id} />}
              <div className="emu-foot">
                <Tag>{status}</Tag>
                <div className="row">
                  {s?.installed && !p && (
                    <>
                      <Button onClick={() => void window.api.invoke('emulators:open', { id: def.id, what: 'app' })} disabled={s.missing}>{t('emu.open')}</Button>
                      <Button onClick={() => void window.api.invoke('emulators:open', { id: def.id, what: 'dir' })}>{t('emu.folder')}</Button>
                      {biosSlotsFor(def.id).some((x) => x.kind === 'bios') && <Button onClick={() => void window.api.invoke('emulators:open', { id: def.id, what: 'bios' })}>{t('emu.biosFolder')}</Button>}
                      {(update || s.missing) && !s.custom && <Button variant="primary" onClick={() => void install(def.id)}>{t(s.missing ? 'emu.reinstall' : 'emu.update')}</Button>}
                      <Button onClick={async () => { if (await confirmDialog(t(s.custom ? 'emu.confirmForget' : 'emu.confirmRemove', { name: def.name }))) void uninstall(def.id) }}>{t(s.custom ? 'emu.forget' : 'emu.remove')}</Button>
                    </>
                  )}
                  {!s?.installed && !p && (
                    <>
                      <Button onClick={() => void locate(def.id)}>{t('emu.locate')}</Button>
                      <Button variant="primary" onClick={() => void install(def.id)}>{t('emu.install')}</Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      </Section>
      ))}
      <Section title={t('emu.custom.title')}>
        <p className="muted">{t('emu.custom.hint')}</p>
        <div className="emu-grid">
          {customs.map((e) => (
            <div key={e.id} className="emu-card">
              <h3>{e.name}</h3>
              <div className="muted emu-exts" title={e.exe}>{e.exe}</div>
              <div className="muted">{t('emu.custom.consoles', { list: e.consoles.map(platformLabel).join(', ') || '—' })}</div>
              <div className="muted emu-exts">{t('emu.acceptedFiles', { list: e.extensions.length ? e.extensions.map((x) => `.${x}`).join(' ') : t('emu.custom.allFiles') })}</div>
              {e.consoles.length > 0 && (
                <div className="chip-row" role="group" aria-label={t('emu.custom.defaultTitle')}>
                  {e.consoles.map((c) => {
                    const on = defaults[c] === e.id
                    return <button key={c} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} title={t('emu.custom.defaultFor', { console: platformLabel(c) })} onClick={() => void setDefault(c, on ? null : e.id)}>{on ? '\u2713 ' : ''}{platformLabel(c)}</button>
                  })}
                </div>
              )}
              <div className="emu-foot">
                <Tag>{e.missing ? t('emu.custom.missing') : t('emu.custom')}</Tag>
                <div className="row">
                  <Button onClick={() => void window.api.invoke('customEmulators:open', e.id)} disabled={e.missing}>{t('emu.open')}</Button>
                  <Button onClick={() => useDialog.getState().open({ kind: 'customEmulator', id: e.id })}>{t('emu.custom.edit')}</Button>
                  <Button onClick={async () => { if (await confirmDialog(t('emu.custom.confirmDelete', { name: e.name }))) { await window.api.invoke('customEmulators:delete', e.id); await useCustomEmulators.getState().refresh(); await useSettings.getState().load() } }}>{t('emu.custom.delete')}</Button>
                </div>
              </div>
            </div>
          ))}
          <button type="button" className="emu-card emu-add" onClick={() => useDialog.getState().open({ kind: 'customEmulator', id: null })}>+ {t('emu.custom.add')}</button>
        </div>
      </Section>
    </div>
  )
}
