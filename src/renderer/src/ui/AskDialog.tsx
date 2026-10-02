import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { Modal } from '@/ui/CollectionDialogs'
import { Button } from '@/ui'

// Remplace window.confirm / window.alert : sous Electron + Windows, ces boîtes natives font perdre le focus à la page,
// après quoi champs de texte et menus déroulants ne répondent plus jusqu'au redémarrage de l'app.
interface Ask { message: string; alert: boolean; resolve: (ok: boolean) => void }
let push: ((a: Ask) => void) | null = null

const ask = (message: string, alert: boolean): Promise<boolean> =>
  new Promise((resolve) => { if (push) push({ message, alert, resolve }); else resolve(false) })

export const confirmDialog = (message: string): Promise<boolean> => ask(message, false)
export const alertDialog = async (message: string): Promise<void> => { await ask(message, true) }

/** Rendue une fois dans App. Les demandes simultanées sont mises en file. */
export function AskHost() {
  const [queue, setQueue] = useState<Ask[]>([])
  useEffect(() => {
    push = (a) => setQueue((q) => [...q, a])
    return () => { push = null }
  }, [])
  const cur = queue[0]
  if (!cur) return null
  const done = (ok: boolean): void => { cur.resolve(ok); setQueue((q) => q.slice(1)) }
  return (
    <Modal title={cur.message} onClose={() => done(false)}>
      <div className="row modal-actions">
        {!cur.alert && <Button onClick={() => done(false)}>{t('dialog.cancel')}</Button>}
        <Button variant="primary" onClick={() => done(true)}>{cur.alert ? t('dialog.close') : t('dialog.confirm')}</Button>
      </div>
    </Modal>
  )
}
