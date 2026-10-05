import { useState } from 'react'
import { t } from '@/i18n'
import { Button } from '@/ui'
import { missingIn } from '@/i18n'
import { useSettings } from '@/store/settings'

/** Réglages → Général : ajouter/retirer un fichier de langue, récupérer le modèle à traduire. */
export function LanguageFiles() {
  const { languages, settings, update, refreshLanguages } = useSettings()
  const [msg, setMsg] = useState('')
  const users = languages.filter((l) => !l.builtin)
  return (
    <div className="field">
      <p className="muted">{t('settings.langFilesHint')}</p>
      <div className="row">
        <Button onClick={async () => {
          const r = await window.api.invoke('lang:import')
          if (!r) return
          if (!r.ok) { setMsg(t(`settings.langError.${r.error}`)); return }
          await refreshLanguages()
          setMsg(t('settings.langAdded', { name: r.file.name, n: missingIn(r.file.code).length }))
        }}>{t('settings.langImport')}</Button>
        <Button onClick={async () => { if (await window.api.invoke('lang:exportTemplate')) setMsg(t('settings.langTemplateSaved')) }}>{t('settings.langTemplate')}</Button>
      </div>
      {msg && <p className="muted" role="status">{msg}</p>}
      {users.map((l) => (
        <div key={l.code} className="row">
          <span>{l.name} <span className="muted">({l.code}{missingIn(l.code).length > 0 ? ` · ${t('settings.langMissing', { n: missingIn(l.code).length })}` : ''})</span></span>
          <Button onClick={async () => {
            await window.api.invoke('lang:remove', l.code)
            if (settings.language === l.code) await update({ language: 'auto' })
            await refreshLanguages()
          }}>{t('settings.langRemove')}</Button>
        </div>
      ))}
    </div>
  )
}
