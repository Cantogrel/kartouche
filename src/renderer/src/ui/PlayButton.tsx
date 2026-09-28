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
        : <Button variant="primary" onClick={() => void click()}>{installed === false && def ? t('play.installFirst', { name: def.name }) : `▶ ${t('play')}`}</Button>}
      {running && <span className="muted">{t('play.quitHint')}</span>}
    </>
  )
}

/**
 * Diagnostic du dernier lancement raté de ce jeu (jeu fermé tout seul très vite après le clic sur Jouer).
 * À placer dans le flux normal de la page (fond uni, lisible, avant les autres informations), jamais par-dessus l'illustration.
 */
export function QuickExitNotice({ entryId }: { entryId: number }) {
  const quickExit = useEmulators((s) => s.quickExits[entryId])
  const dismiss = useEmulators((s) => s.dismissQuickExit)
  const [copied, setCopied] = useState(false)
  if (!quickExit) return null
  // Un échec connu avant même le lancement (LaunchResult.error) porte déjà sa clé i18n ; sinon on cherche une cause
  // connue dans le journal d'une vraie fermeture rapide du processus.
  const reasonKey = quickExit.immediate ? `play.${quickExit.immediate}` : explainFailure(quickExit.log)
  // Le journal technique n'a de sens que pour une vraie fermeture de processus, ou l'exception de démarrage (spawn) :
  // pour les autres échecs immédiats (zip illisible, pas de fichier…), le message ci-dessus dit déjà tout.
  const showLog = !!quickExit.log && (!quickExit.immediate || quickExit.immediate === 'spawn')
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(quickExit.log ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* presse-papier indisponible : rien à faire de plus */ }
  }
  return (
    <div className="panel quick-exit">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>{t(quickExit.immediate ? 'play.launchFailedHeader' : 'play.quickExitHeader', { seconds: Math.round(quickExit.elapsedMs / 1000) })}</div>
        <Button variant="icon" title={t('play.dismiss')} aria-label={t('play.dismiss')} onClick={() => dismiss(entryId)}>✕</Button>
      </div>
      {reasonKey && <strong>{t(reasonKey)}</strong>}
      {reasonKey === 'play.quickExitSbi' && <SbiImportControl entryId={entryId} />}
      {reasonKey === 'play.quickExit3dsCrypto' && <AzaharKeysImportControl />}
      {showLog ? (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted">{t('play.quickExitLog')}</span>
            <Button onClick={() => void copy()}>{copied ? t('play.copied') : t('play.copyLog')}</Button>
          </div>
          <pre>{quickExit.log}</pre>
        </>
      ) : (!quickExit.immediate && <span className="muted">{t('play.quickExitNoLog')}</span>)}
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

/** Glisser-déposer ou sélectionner un aes_keys.txt / seeddb.bin pour Azahar : même reconnaissance et placement automatique que le panneau BIOS (bios:import gère déjà les deux emplacements). */
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
