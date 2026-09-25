import { useState } from 'react'
import { t } from '@/i18n'

const SECTIONS = ['general', 'emulation', 'import', 'controller', 'appearance', 'apiKeys', 'about'] as const

export function Settings() {
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('general')
  return (
    <div className="content settings">
      <nav className="settings-nav">
        {SECTIONS.map((s) => (
          <button key={s} className={`nav-item${section === s ? ' active' : ''}`} onClick={() => setSection(s)}>{t(`settings.${s}`)}</button>
        ))}
      </nav>
      <div className="panel settings-body">
        <h2>{t(`settings.${section}`)}</h2>
        {section === 'general' && (
          <>
            <label className="field">{t('settings.dataFolder')}<input readOnly value="C:\Games\RomVault\data" /></label>
            <label className="field">{t('settings.language')}<select><option>Auto</option><option>English</option><option>Français</option></select></label>
          </>
        )}
      </div>
    </div>
  )
}
