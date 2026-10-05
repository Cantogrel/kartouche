import { t } from '@/i18n'
import { Button } from '@/ui'
import { useSettings } from '@/store/settings'
import { DEFAULT_HOME_LAYOUT, moveHomeSection, toggleHomeSection } from '@shared/homeLayout'

/** Réglages → Apparence : ordre et visibilité des blocs de l'accueil (classique et Big Picture). */
export function HomeLayoutEditor() {
  const { settings, update } = useSettings()
  const layout = settings.homeLayout
  return (
    <div className="field">
      <h3>{t('settings.homeLayout')}</h3>
      <p className="muted">{t('settings.homeLayoutHint')}</p>
      <ul className="home-layout">
        {layout.order.map((s, i) => (
          <li key={s} className="row">
            <label className="check">
              <input type="checkbox" checked={!layout.hidden.includes(s)} aria-label={`${t('settings.homeShow')} : ${t(`home.sec.${s}`)}`} onChange={() => void update({ homeLayout: toggleHomeSection(layout, s) })} /> {t(`home.sec.${s}`)}
            </label>
            <Button disabled={i === 0} aria-label={t('settings.homeUp')} title={t('settings.homeUp')} onClick={() => void update({ homeLayout: moveHomeSection(layout, s, -1) })}>↑</Button>
            <Button disabled={i === layout.order.length - 1} aria-label={t('settings.homeDown')} title={t('settings.homeDown')} onClick={() => void update({ homeLayout: moveHomeSection(layout, s, 1) })}>↓</Button>
          </li>
        ))}
      </ul>
      <Button onClick={() => void update({ homeLayout: DEFAULT_HOME_LAYOUT })}>{t('settings.homeReset')}</Button>
    </div>
  )
}
