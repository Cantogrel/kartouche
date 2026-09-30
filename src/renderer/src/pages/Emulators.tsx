import { useEffect } from 'react'
import { Button, ProgressBar, Section, Tag } from '@/ui'
import { t } from '@/i18n'
import { EMULATORS, MANUAL_PAD_EMULATORS, compareVersions, emulatorMaker, emulatorRank, type EmulatorDef } from '@shared/emulators'
import { CONSOLES, MAKERS } from '@shared/consoles'
import { extensionsForConsoles } from '@shared/library'
import { useEmulators } from '@/store/emulators'
import { BiosPanel } from '@/ui/BiosPanel'
import { biosSlotsFor } from '@shared/bios'

const consoleNames = (def: EmulatorDef): string => def.consoles.map((c) => CONSOLES.find((x) => x.id === c)?.label ?? c).join(', ')
const acceptedFiles = (def: EmulatorDef): string => extensionsForConsoles(def.consoles).map((x) => `.${x}`).join(' ')

const mb = (n: number): string => (n / 1048576).toFixed(n > 10485760 ? 0 : 1)

export function Emulators() {
  const { list, loaded, progress, errors, latest, checking, refresh, install, uninstall, locate, check } = useEmulators()
  useEffect(() => { void refresh() }, [refresh])
  const state = (id: string) => list.find((e) => e.id === id)
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
                    {p.phase === 'download' ? t('emu.downloading', { done: mb(p.done), total: p.total ? mb(p.total) : '?' }) : p.phase === 'extract' ? t('emu.extracting') : p.phase === 'cores' ? t('emu.cores', { name: p.message ?? '' }) : t('emu.resolving')}
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
                      <Button onClick={() => { if (window.confirm(t(s.custom ? 'emu.confirmForget' : 'emu.confirmRemove', { name: def.name }))) void uninstall(def.id) }}>{t(s.custom ? 'emu.forget' : 'emu.remove')}</Button>
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
    </div>
  )
}
