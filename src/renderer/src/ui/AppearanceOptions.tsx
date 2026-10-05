import { t } from '@/i18n'
import { useSettings } from '@/store/settings'
import { RADII } from '@shared/appearance'

/** Dernier élément de la rangée « Couleur d'accent » : un sélecteur de couleur libre (sélectionné quand une couleur personnelle est active), . */
export function AccentCustom() {
  const { settings, update } = useSettings()
  const custom = settings.accentColor
  return (
    <>
      <label className={`swatch-custom${custom ? ' on' : ''}`} style={custom ? { background: custom } : undefined} title={t('settings.accentCustom')}>
        <input type="color" aria-label={t('settings.accentCustom')} value={custom || '#7c8cff'} onChange={(e) => void update({ accentColor: e.target.value })} />
      </label>
      {custom && <button className="back" type="button" aria-label={t('settings.accentCustomClear')} title={t('settings.accentCustomClear')} onClick={() => void update({ accentColor: '' })}>×</button>}
    </>
  )
}

/** Réglages → Apparence : forme des coins et contraste renforcé. */
export function AppearanceOptions() {
  const { settings, update } = useSettings()
  return (
    <>
      <label className="field">
        {t('settings.radius')}
        <select value={settings.radius} onChange={(e) => void update({ radius: e.target.value as (typeof RADII)[number] })}>
          {RADII.map((r) => <option key={r} value={r}>{t(`radius.${r}`)}</option>)}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.highContrast} onChange={(e) => void update({ highContrast: e.target.checked })} /> {t('settings.highContrast')}
      </label>
    </>
  )
}
