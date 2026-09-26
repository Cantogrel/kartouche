import { useState } from 'react'
import { Button } from '@/ui'
import { t } from '@/i18n'
import { emulatorForConsole } from '@shared/emulators'
import { useEmulators } from '@/store/emulators'
import { useApp } from '@/store/app'
import type { LibraryEntry } from '@shared/library'

/** Bouton « Jouer » : lance le jeu ; si l'émulateur manque, propose d'aller l'installer. */
export function PlayButton({ entry }: { entry: LibraryEntry }) {
  const running = useEmulators((s) => s.running.includes(entry.id))
  const play = useEmulators((s) => s.play)
  const installed = useEmulators((s) => s.list.find((e) => e.id === emulatorForConsole(entry.console)?.id)?.installed)
  const navigate = useApp((s) => s.go)
  const [error, setError] = useState<string | null>(null)
  const def = emulatorForConsole(entry.console)
  const click = async (): Promise<void> => {
    if (def && installed === false) { navigate('emulators'); return }
    const r = await play(entry.id)
    setError(r.ok ? null : t(`play.${r.error ?? 'spawn'}`) + (r.detail && r.error === 'spawn' ? ` (${r.detail})` : ''))
  }
  return (
    <>
      {error && <span className="muted">{error}</span>}
      {running
        ? <Button onClick={() => void window.api.invoke('game:stop', entry.id)}>■ {t('play.stop')}</Button>
        : <Button variant="primary" onClick={() => void click()}>{installed === false && def ? t('play.installFirst', { name: def.name }) : `▶ ${t('play')}`}</Button>}
      {running && <span className="muted">{t('play.quitHint')}</span>}
    </>
  )
}
