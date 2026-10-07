import { useEffect, useState, type ReactNode } from 'react'
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

/** Mise en forme inline du markdown source : `**gras**` et `` `code` ``. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code>
        : part)
}

/** Met en gras une éventuelle étiquette de tête non balisée (« Corrigé : », « Catalogue : »…), puis applique la mise en forme inline. */
function renderItem(text: string): ReactNode {
  const m = !text.startsWith('**') ? /^([^:*`]{2,24}) : (.*)$/.exec(text) : null
  return m ? <><strong>{m[1]} :</strong> {inline(m[2])}</> : inline(text)
}

/** Rendue une fois dans App : popup automatique après mise à jour, ou rouverte depuis Paramètres → À propos. */
export function ChangelogDialog() {
  const { open, data, close } = useChangelog()
  const [older, setOlder] = useState<{ version: string; notes: string }[]>([])
  /** Position dans [version en cours, ...versions précédentes] : 0 = la version affichée à l'ouverture. */
  const [at, setAt] = useState(0)
  useEffect(() => {
    setAt(0)
    setOlder([])
    if (!open || !data) return
    let live = true
    void window.api.invoke('update:olderChangelogs', data.version).then((list) => { if (live) setOlder(list) })
    return () => { live = false }
  }, [open, data])
  if (!open || !data) return null
  const pages = [data, ...older]
  const shown = pages[Math.min(at, pages.length - 1)]
  const items = shown.notes ? parseItems(shown.notes) : []
  return (
    <Modal title={t('changelog.title', { v: shown.version })} onClose={close}>
      {items.length
        ? <ul className="modal-list changelog-notes">{items.map((item, i) => <li key={i}>{renderItem(item)}</li>)}</ul>
        : <div className="modal-list changelog-notes">{t('changelog.empty')}</div>}
      <div className="row modal-actions">
        {pages.length > 1 && (
          <div className="row" style={{ marginRight: 'auto' }}>
            <Button onClick={() => setAt(at + 1)} disabled={at >= pages.length - 1}>◀ {t('changelog.prev')}</Button>
            <Button onClick={() => setAt(at - 1)} disabled={at <= 0}>{t('changelog.next')} ▶</Button>
          </div>
        )}
        <Button variant="primary" onClick={close}>{t('dialog.close')}</Button>
      </div>
    </Modal>
  )
}
