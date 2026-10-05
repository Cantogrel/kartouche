import { useState, type DragEvent, type KeyboardEvent } from 'react'
import { t } from '@/i18n'
import { Button } from '@/ui'
import { useSettings } from '@/store/settings'
import { DEFAULT_HOME_LAYOUT, moveHomeSection, reorderHomeSection, toggleHomeSection, type HomeSection } from '@shared/homeLayout'

/** Réglages → Apparence : ordre (glisser-déposer par la poignée à gauche) et visibilité des blocs de l'accueil (classique et Big Picture). */
export function HomeLayoutEditor() {
  const { settings, update } = useSettings()
  const layout = settings.homeLayout
  const [armed, setArmed] = useState<HomeSection | null>(null)
  const [dragging, setDragging] = useState<HomeSection | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const onDrop = (e: DragEvent, to: number): void => {
    e.preventDefault()
    if (dragging) void update({ homeLayout: reorderHomeSection(layout, dragging, to) })
    setDragging(null); setOver(null); setArmed(null)
  }
  // Même réorganisation au clavier depuis la poignée, pour ne pas dépendre de la souris.
  const onHandleKey = (e: KeyboardEvent, s: HomeSection): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    void update({ homeLayout: moveHomeSection(layout, s, e.key === 'ArrowUp' ? -1 : 1) })
  }

  return (
    <div className="field">
      <h3>{t('settings.homeLayout')}</h3>
      <p className="muted">{t('settings.homeLayoutHint')}</p>
      <ul className="home-layout">
        {layout.order.map((s, i) => (
          <li
            key={s}
            className={`home-row${dragging === s ? ' dragging' : ''}${over === i && dragging !== null && dragging !== s ? ' drop-target' : ''}`}
            draggable={armed === s}
            onDragStart={(e) => { setDragging(s); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s) }}
            onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(i) } }}
            onDrop={(e) => onDrop(e, i)}
            onDragEnd={() => { setDragging(null); setOver(null); setArmed(null) }}
          >
            <span
              className="grabber" role="button" tabIndex={0} aria-label={`${t('settings.homeDrag')} : ${t(`home.sec.${s}`)}`} title={t('settings.homeDrag')}
              onMouseDown={() => setArmed(s)} onMouseUp={() => setArmed(null)} onKeyDown={(e) => onHandleKey(e, s)}
            >⠿</span>
            <label className="check">
              <input type="checkbox" checked={!layout.hidden.includes(s)} aria-label={`${t('settings.homeShow')} : ${t(`home.sec.${s}`)}`} onChange={() => void update({ homeLayout: toggleHomeSection(layout, s) })} /> {t(`home.sec.${s}`)}
            </label>
          </li>
        ))}
      </ul>
      <Button onClick={() => void update({ homeLayout: DEFAULT_HOME_LAYOUT })}>{t('settings.homeReset')}</Button>
    </div>
  )
}
