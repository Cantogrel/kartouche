import { useEffect, useRef } from 'react'
import { t } from '@/i18n'
import { focusEl, navItems, useNav, useTypeText } from './useNav'

const ROWS = ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123', "456789-'.:"]

/**
 * Clavier virtuel de la manette : les touches sont des éléments du même moteur de focus.
 * X = effacer, Y = espace, B = fermer, Start = valider.
 */
export function VirtualKeyboard({ value, onChange, onClose }: { value: string; onChange: (v: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { focusEl(navItems().find((e) => e.dataset.key === 'H')) }, [])
  const type = (c: string): void => onChange(value + c)
  useTypeText(value, onChange, true)
  useNav((a) => {
    if (a === 'back' || a === 'start') onClose()
    else if (a === 'x') onChange(value.slice(0, -1))
    else if (a === 'y') onChange(value + ' ')
  }, true)
  return (
    <div className="bp-overlay">
      <div className="vk" data-focus-root ref={ref}>
        <div className="vk-value">{value || <span className="muted">{t('bp.searchHint')}</span>}<i /></div>
        {ROWS.map((r) => (
          <div key={r} className="vk-row">
            {[...r].map((c) => <button key={c} data-nav data-key={c} className="vk-key" onClick={() => type(c.toLowerCase())}>{c}</button>)}
          </div>
        ))}
        <div className="vk-row">
          <button data-nav className="vk-key wide" onClick={() => type(' ')}>␣ {t('bp.space')}</button>
          <button data-nav className="vk-key wide" onClick={() => onChange(value.slice(0, -1))}>⌫</button>
          <button data-nav className="vk-key wide" onClick={() => onChange('')}>{t('bp.clear')}</button>
          <button data-nav className="vk-key wide ok" onClick={onClose}>{t('bp.ok')}</button>
        </div>
        <div className="bp-hints"><span>Ⓐ {t('bp.select')}</span><span>Ⓧ ⌫</span><span>Ⓨ ␣</span><span>Ⓑ {t('bp.ok')}</span></div>
      </div>
    </div>
  )
}
