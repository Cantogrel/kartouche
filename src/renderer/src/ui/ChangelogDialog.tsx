import { t } from '@/i18n'
import { useChangelog } from '@/store/changelog'
import { Modal } from '@/ui/CollectionDialogs'
import { Button } from '@/ui'

/** Rendue une fois dans App : popup automatique après mise à jour, ou rouverte depuis Paramètres → À propos. */
export function ChangelogDialog() {
  const { open, data, close } = useChangelog()
  if (!open || !data) return null
  return (
    <Modal title={t('changelog.title', { v: data.version })} onClose={close}>
      <div className="modal-list changelog-notes">{data.notes || t('changelog.empty')}</div>
      <div className="row modal-actions"><Button variant="primary" onClick={close}>{t('dialog.close')}</Button></div>
    </Modal>
  )
}
