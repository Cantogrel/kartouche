import { useEffect, useState } from 'react'
import type { SyncProgress } from '@shared/catalog'
import { emulatorById } from '@shared/emulators'
import { t } from '@/i18n'
import { useEmulators } from '@/store/emulators'
import { useLibrary } from '@/store/library'

/** Barre d'état : décrit la tâche en cours (catalogue, installation d'émulateur, import), sinon « aucune tâche ». */
export function StatusBar() {
  const [sync, setSync] = useState<SyncProgress | null>(null)
  const emu = useEmulators((s) => s.progress)
  const libBusy = useLibrary((s) => s.busy)
  const libProgress = useLibrary((s) => s.progress)
  useEffect(() => window.api.on('catalog:progress', (p) => setSync(p.total > 0 && p.done >= p.total ? null : p)), [])

  const jobs: string[] = []
  if (sync) jobs.push(sync.console === 'popularity' ? t('catalog.rating', { n: sync.done, total: sync.total }) : t('catalog.syncing', { n: sync.done, total: sync.total }))
  for (const p of Object.values(emu)) {
    const pct = p.total > 0 ? ` ${Math.round((p.done / p.total) * 100)} %` : '…'
    jobs.push(t('footer.installing', { name: emulatorById(p.id)?.name ?? p.id }) + pct)
  }
  if (libBusy) jobs.push(libProgress ? t('footer.importing', { n: libProgress.done, total: libProgress.total }) : t('footer.importing0'))

  return (
    <div className="statusbar">
      {jobs.length ? <><span className="statusbar-spin" aria-hidden />{jobs.join(' · ')}</> : t('footer.noJob')}
    </div>
  )
}
