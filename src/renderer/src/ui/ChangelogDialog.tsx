import type { ReactNode } from 'react'
import { t } from '@/i18n'
import { useChangelog } from '@/store/changelog'
import { Modal } from '@/ui/CollectionDialogs'
import { Button } from '@/ui'

/** Un item par puce `- …` du markdown source ; les lignes de continuation indentées sont recollées à la puce. */
function parseItems(notes: string): string[] {
  const items: string[] = []
  for (const raw of notes.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('- ')) items.push(line.slice(2).trim())
    else if (items.length) items[items.length - 1] += ' ' + line
  }
  return items
}

/** Met en gras une éventuelle étiquette de tête (« Corrigé : », « Catalogue : »…), seule mise en forme que porte ce markdown. */
function renderItem(text: string): ReactNode {
  const m = /^([^:]{2,24}) : (.*)$/.exec(text)
  return m ? <><strong>{m[1]} :</strong> {m[2]}</> : text
}

/** Rendue une fois dans App : popup automatique après mise à jour, ou rouverte depuis Paramètres → À propos. */
export function ChangelogDialog() {
  const { open, data, close } = useChangelog()
  if (!open || !data) return null
  const items = data.notes ? parseItems(data.notes) : []
  return (
    <Modal title={t('changelog.title', { v: data.version })} onClose={close}>
      {items.length
        ? <ul className="modal-list changelog-notes">{items.map((item, i) => <li key={i}>{renderItem(item)}</li>)}</ul>
        : <div className="modal-list changelog-notes">{t('changelog.empty')}</div>}
      <div className="row modal-actions"><Button variant="primary" onClick={close}>{t('dialog.close')}</Button></div>
    </Modal>
  )
}
