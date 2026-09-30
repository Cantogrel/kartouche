import { useState, type DragEvent } from 'react'
import { Button } from '@/ui'
import { t } from '@/i18n'
import { emulatorForConsole, explainFailure } from '@shared/emulators'
import { useEmulators } from '@/store/emulators'
import { useApp } from '@/store/app'
import type { LibraryEntry } from '@shared/library'

/** Bouton « Jouer » : lance le jeu ; si l'émulateur manque, propose d'aller l'installer. */
export function PlayButton({ entry }: { entry: LibraryEntry }) {
  const running = useEmulators((s) => s.running.includes(entry.id))
  const launching = useEmulators((s) => s.launching.includes(entry.id))
  const play = useEmulators((s) => s.play)
  const installed = useEmulators((s) => s.list.find((e) => e.id === emulatorForConsole(entry.console)?.id)?.installed)
  const navigate = useApp((s) => s.go)
  const def = emulatorForConsole(entry.console)
  const click = async (): Promise<void> => {
    if (def && installed === false) { navigate('emulators'); return }
    // Un échec est affiché via QuickExitNotice (même vitrine qu'une fermeture rapide) : voir useEmulators.play.
    await play(entry.id)
  }
  return (
    <>
      {running
        ? <Button onClick={() => void window.api.invoke('game:stop', entry.id)}>■ {t('play.stop')}</Button>
        // launching : le clic est pris en compte mais rien n'est encore lancé (peut prendre plusieurs minutes la
        // première fois pour un jeu Vita — install avant de pouvoir jouer) ; désactivé pour éviter un double clic.
        : <Button variant="primary" disabled={launching} onClick={() => void click()}>
            {launching ? t('play.launching') : installed === false && def ? t('play.installFirst', { name: def.name }) : `▶ ${t('play')}`}
          </Button>}
      {running && <span className="muted">{t('play.quitHint')}</span>}
    </>
  )
}

/** Ouvre directement l'émulateur associé (son propre écran d'accueil/config), sans lancer ce jeu précis. */
export function OpenEmulatorButton({ entry }: { entry: LibraryEntry }) {
  const def = emulatorForConsole(entry.console)
  const emu = useEmulators((s) => s.list.find((e) => e.id === def?.id))
  if (!def || !emu?.installed || emu.missing) return null
  return <Button onClick={() => void window.api.invoke('emulators:open', { id: def.id, what: 'app' })}>{t('content.openEmulator', { name: def.name })}</Button>
}

/**
 * Diagnostic du dernier lancement raté de ce jeu (jeu fermé tout seul très vite après le clic sur Jouer).
 * À placer dans le flux normal de la page (fond uni, lisible, avant les autres informations), jamais par-dessus l'illustration.
 */
export function QuickExitNotice({ entryId }: { entryId: number }) {
  const quickExit = useEmulators((s) => s.quickExits[entryId])
  const dismiss = useEmulators((s) => s.dismissQuickExit)
  const [copiedMsg, setCopiedMsg] = useState(false)
  const [copiedLog, setCopiedLog] = useState(false)
  if (!quickExit) return null
  // Un échec connu avant même le lancement (LaunchResult.error) porte déjà sa clé i18n ; sinon on cherche une cause
  // connue dans le journal d'une vraie fermeture rapide du processus.
  const reasonKey = quickExit.immediate ? `play.${quickExit.immediate}` : explainFailure(quickExit.log)
  const hasLog = !!quickExit.log
  // Le journal technique n'apporte rien de plus quand la cause est déjà expliquée en clair au-dessus : on ne le montre
  // que pour l'exception de démarrage (spawn, message trop générique pour être utile seul) ou une fermeture non reconnue.
  const showLog = hasLog && (quickExit.immediate === 'spawn' || (!quickExit.immediate && !reasonKey))
  const copy = async (text: string, setFlag: (v: boolean) => void): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setFlag(true)
      setTimeout(() => setFlag(false), 1500)
    } catch { /* presse-papier indisponible : rien à faire de plus */ }
  }
  return (
    <div className="panel quick-exit">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>{t(quickExit.immediate ? 'play.launchFailedHeader' : 'play.quickExitHeader', { seconds: Math.round(quickExit.elapsedMs / 1000) })}</div>
        <Button variant="icon" title={t('play.dismiss')} aria-label={t('play.dismiss')} onClick={() => dismiss(entryId)}>✕</Button>
      </div>
      {reasonKey && (
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
          <strong>{t(reasonKey)}</strong>
          <Button onClick={() => void copy(t(reasonKey), setCopiedMsg)}>{copiedMsg ? t('play.copied') : t('play.copyLog')}</Button>
        </div>
      )}
      {reasonKey === 'play.quickExitSbi' && <SbiImportControl entryId={entryId} />}
      {reasonKey === 'play.quickExit3dsCrypto' && <AzaharKeysImportControl />}
      {showLog ? (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted">{t('play.quickExitLog')}</span>
            <Button onClick={() => void copy(quickExit.log ?? '', setCopiedLog)}>{copiedLog ? t('play.copied') : t('play.copyLog')}</Button>
          </div>
          <pre>{quickExit.log}</pre>
        </>
      ) : (!quickExit.immediate && !reasonKey && !hasLog && <span className="muted">{t('play.quickExitNoLog')}</span>)}
    </div>
  )
}

/** Glisser-déposer ou sélectionner le fichier .sbi manquant : copié à côté de la ROM, sous le nom que l'émulateur attend. */
function SbiImportControl({ entryId }: { entryId: number }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const doImport = async (path: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const r = await window.api.invoke('library:importSbi', { entryId, path })
      setMessage(t(r.ok ? 'play.sbiImported' : 'play.sbiFailed'))
    } finally { setBusy(false) }
  }
  const pick = async (): Promise<void> => {
    const path = await window.api.invoke('library:pickSbi')
    if (path) void doImport(path)
  }
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const path = e.dataTransfer.files[0] && window.api.pathOf(e.dataTransfer.files[0])
    if (path) void doImport(path)
  }
  return (
    <div className={`bios-panel${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <span className="muted">{t('play.sbiDrop')}</span>
      <Button onClick={() => void pick()} disabled={busy}>{t('play.sbiPick')}</Button>
      {message && <span className="muted">{message}</span>}
    </div>
  )
}

/**
 * Repli pour le cas rare où le message « jeu détecté comme chiffré » vient vraiment d'une clé/graine locale
 * (build d'Azahar sans clés intégrées, ou jeu à graine spécifique) plutôt que d'un fichier mal décrypté — voir
 * play.quickExit3dsCrypto. Même reconnaissance et placement automatique que le panneau BIOS (bios:import gère
 * déjà les deux emplacements).
 */
function AzaharKeysImportControl() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const doImport = async (path: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const [r] = await window.api.invoke('bios:import', { emulator: 'azahar', paths: [path] })
      setMessage(r?.ok ? t('play.azaharKeysImported', { slot: t(`bios.slot.${r.slot}`) }) : t('play.azaharKeysFailed'))
    } finally { setBusy(false) }
  }
  const pick = async (): Promise<void> => {
    const paths = await window.api.invoke('bios:pick', 'azahar')
    if (paths[0]) void doImport(paths[0])
  }
  const drop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const path = e.dataTransfer.files[0] && window.api.pathOf(e.dataTransfer.files[0])
    if (path) void doImport(path)
  }
  return (
    <div className={`bios-panel${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={drop}>
      <span className="muted">{t('play.azaharKeysDrop')}</span>
      <Button onClick={() => void pick()} disabled={busy}>{t('play.azaharKeysPick')}</Button>
      {message && <span className="muted">{message}</span>}
    </div>
  )
}
