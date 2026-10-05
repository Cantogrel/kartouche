import { useState } from 'react'
import { t } from '@/i18n'
import { Button } from '@/ui'
import { useSettings } from '@/store/settings'
import { accentReadable, exportTheme, parseTheme, RADII } from '@shared/appearance'

/** Réglages → Apparence : accent personnel, arrondi, contraste renforcé, export/import d'un thème. Tout s'applique et se sauvegarde au changement. */
export function AppearanceAdvanced() {
  const { settings, update } = useSettings()
  const theme = useSettings((s) => s.theme)
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  const custom = settings.accentColor
  return (
    <>
      <h3>{t('settings.appearanceAdvanced')}</h3>
      <div className="field">
        {t('settings.accentCustom')}
        <div className="row">
          <input type="color" aria-label={t('settings.accentCustom')} value={custom || '#7c8cff'} onChange={(e) => void update({ accentColor: e.target.value })} />
          {custom && <Button onClick={() => void update({ accentColor: '' })}>{t('settings.accentCustomClear')}</Button>}
        </div>
        {custom && !accentReadable(custom, theme) && <p className="muted" role="alert">{t('settings.accentLowContrast')}</p>}
      </div>
      <label className="field">
        {t('settings.radius')}
        <select value={settings.radius} onChange={(e) => void update({ radius: e.target.value as (typeof RADII)[number] })}>
          {RADII.map((r) => <option key={r} value={r}>{t(`radius.${r}`)}</option>)}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.highContrast} onChange={(e) => void update({ highContrast: e.target.checked })} /> {t('settings.highContrast')}
      </label>
      <div className="field">
        {t('settings.themeShare')}
        <textarea rows={6} value={text} spellCheck={false} placeholder={t('settings.themeSharePlaceholder')} onChange={(e) => { setText(e.target.value); setMsg('') }} />
        <div className="row">
          <Button onClick={() => { const json = exportTheme(settings); setText(json); void navigator.clipboard?.writeText(json).catch(() => undefined); setMsg(t('settings.themeExported')) }}>{t('settings.themeExport')}</Button>
          <Button onClick={() => {
            const parsed = parseTheme(text)
            if (!parsed) { setMsg(t('settings.themeInvalid')); return }
            void update(parsed).then(() => setMsg(t('settings.themeImported')))
          }}>{t('settings.themeImport')}</Button>
        </div>
        {msg && <p className="muted" role="status">{msg}</p>}
      </div>
    </>
  )
}
