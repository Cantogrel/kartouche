import { useEffect, useState } from 'react'
import type { SyncProgress } from '@shared/catalog'
import { emulatorById } from '@shared/emulators'
import { t } from '@/i18n'
import { useEmulators } from '@/store/emulators'
import { useLibrary } from '@/store/library'
import { useDownloads } from '@/store/downloads'

interface Job { label: string; fraction: number | null }

const clamp = (n: number): number => Math.min(1, Math.max(0, n))

/** Barre d'état : décrit la tâche en cours (catalogue, installation d'émulateur, import) avec une barre de
 * progression dès qu'une fraction est connue, sinon « aucune tâche ». */
export function StatusBar() {
  const [sync, setSync] = useState<SyncProgress | null>(null)
  const emu = useEmulators((s) => s.progress)
  const removing = useEmulators((s) => s.removing)
  const firmware = useEmulators((s) => s.firmware)
  const libBusy = useLibrary((s) => s.busy)
  const libProgress = useLibrary((s) => s.progress)
  const downloads = useDownloads((s) => s.jobs)
  useEffect(() => window.api.on('catalog:progress', (p) => setSync(p.total > 0 && p.done >= p.total ? null : p)), [])

  const jobs: Job[] = []
  if (sync) jobs.push({ label: sync.console === 'popularity' ? t('catalog.rating', { n: sync.done, total: sync.total }) : t('catalog.syncing', { n: sync.done, total: sync.total }), fraction: sync.total > 0 ? sync.done / sync.total : null })
  for (const p of Object.values(emu)) {
    const fraction = p.total > 0 ? p.done / p.total : null
    jobs.push({ label: t('footer.installing', { name: emulatorById(p.id)?.name ?? p.id }) + (fraction !== null ? ` ${Math.round(fraction * 100)} %` : ' …'), fraction })
  }
  for (const id of Object.keys(removing)) jobs.push({ label: `${t('footer.removing', { name: emulatorById(id)?.name ?? id })} …`, fraction: null })
  for (const p of Object.values(firmware)) {
    const fraction = p.phase === 'download' && p.total > 0 ? p.done / p.total : null
    jobs.push({ label: t('footer.firmware', { name: emulatorById(p.id)?.name ?? p.id }) + (fraction !== null ? ` ${Math.round(fraction * 100)} %` : ' …'), fraction })
  }
  for (const d of Object.values(downloads)) {
    const fraction = d.phase === 'downloading' && d.total > 0 ? d.done / d.total : null
    jobs.push({ label: t('footer.downloading', { name: d.label }) + (fraction !== null ? ` ${Math.round(fraction * 100)} %` : ' …'), fraction })
  }
  if (libBusy) {
    // Fraction du fichier en cours (empreinte + copie) mêlée au compte de fichiers : une seule grosse ROM avance en continu au lieu de rester bloquée à 0/1.
    const fileFraction = libProgress?.bytesTotal ? (libProgress.bytesDone ?? 0) / libProgress.bytesTotal : 0
    jobs.push({
      label: libProgress?.current ? t('footer.importingFile', { name: libProgress.current, n: libProgress.done, total: libProgress.total }) : libProgress ? t('footer.importing', { n: libProgress.done, total: libProgress.total }) : t('footer.importing0'),
      fraction: libProgress && libProgress.total > 0 ? (libProgress.done + fileFraction) / libProgress.total : null
    })
  }
  const bar = jobs.find((j) => j.fraction !== null)

  return (
    <div className="statusbar" role="status" aria-live="polite">
      {jobs.length ? (
        <>
          <span className="statusbar-spin" aria-hidden />
          <span className="statusbar-text">{jobs.map((j) => j.label).join(' · ')}</span>
          {bar && (
            <span className="statusbar-track">
              <span className="statusbar-fill" style={{ width: `${Math.round(clamp(bar.fraction as number) * 100)}%` }} />
            </span>
          )}
        </>
      ) : t('footer.noJob')}
    </div>
  )
}
