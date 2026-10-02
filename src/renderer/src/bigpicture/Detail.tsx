import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { Badge, Cover, Tag, artStyle } from '@/ui'
import { useLibrary } from '@/store/library'
import { useEmulators } from '@/store/emulators'
import { useDownloads } from '@/store/downloads'
import { useSettings } from '@/store/settings'
import { emulatorForConsole } from '@shared/emulators'
import { consoleById } from '@shared/consoles'
import { canonicalGenre, genreLabel } from '@shared/genres'
import { formatSize } from '@shared/format'
import { isTorrentSource } from '@shared/uriKind'
import type { CatalogGame, GameDetails } from '@shared/catalog'
import type { LibraryEntry } from '@shared/library'
import type { GameSource } from '@shared/sourceList'
import { focusEl, navItems } from './useNav'

const label = (c: string): string => consoleById(c)?.label ?? c

/** Fiche d'un jeu (catalogue ou bibliothèque) : mêmes données que la fiche classique, actions à la manette. */
export function Detail({ gameId, entry, onClose }: { gameId: number | null; entry?: LibraryEntry; onClose: () => void }) {
  const owned = useLibrary((s) => entry ?? (gameId !== null ? s.entries.find((e) => e.gameId === gameId) : undefined))
  const lang = useSettings((s) => s.lang)
  const [game, setGame] = useState<CatalogGame | null>(null)
  const [details, setDetails] = useState<GameDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = useEmulators((s) => (owned ? s.running.includes(owned.id) : false))
  const play = useEmulators((s) => s.play)
  const def = emulatorForConsole(game?.console ?? owned?.console ?? '')
  const installed = useEmulators((s) => s.list.find((e) => e.id === def?.id)?.installed)
  // Un seul jeu à la fois (cf. launchGame) : `otherRunning` propose de fermer l'autre plutôt qu'un message sec, avec
  // le même mécanisme que PlayButton en mode classique (window.confirm), mais navigable à la manette ici.
  const [confirmStop, setConfirmStop] = useState<{ otherId: number; title: string } | null>(null)
  // Téléchargement (P03/P05, même pipeline que la fiche classique) : plusieurs sources possibles pour un même jeu
  // (régions, révisions…) — choisies via une liste dans une fenêtre dédiée plutôt qu'un <select> natif ou un bouton
  // qui ferait défiler les titres en place (souvent longs, ex. « (Europe, Australia) (En,Fr,De,Es,It) » : ça débordait
  // et cassait la barre d'actions avec `white-space: nowrap` sur `.bp-btn`).
  const [sources, setSources] = useState<GameSource[]>([])
  const [sourceId, setSourceId] = useState<number | undefined>(undefined)
  const [pickingSource, setPickingSource] = useState(false)
  const job = useDownloads((s) => (sourceId !== undefined ? s.jobs[sourceId] : undefined))
  const startDownload = useDownloads((s) => s.start)
  const cancelDownload = useDownloads((s) => s.cancel)
  const downloading = job?.phase === 'downloading'
  const dlError = useDownloads((s) => (sourceId !== undefined ? s.errors[sourceId] : undefined))

  useEffect(() => {
    if (gameId === null) return
    void window.api.invoke('catalog:get', gameId).then(setGame)
    void window.api.invoke('catalog:details', { id: gameId }).then(setDetails)
    void window.api.invoke('sources:forGame', gameId).then((s) => { setSources(s); setSourceId(s[0]?.id) })
  }, [gameId])
  useEffect(() => { focusEl(navItems()[0]) }, [])
  useEffect(() => { if (confirmStop) focusEl(navItems()[0]) }, [confirmStop])
  useEffect(() => { if (pickingSource) focusEl(navItems()[0]) }, [pickingSource])

  const title = game?.name ?? owned?.title ?? ''
  const cons = game?.console ?? owned?.console ?? ''
  const year = game?.year ?? details?.releaseYear
  const developer = game?.developer ?? details?.developer
  const genres = [...new Set([game?.genre, ...(details?.genres ?? []).map((g) => canonicalGenre(g))].filter((g): g is string => !!g))].map((g) => genreLabel(g, lang))
  const launch = async (): Promise<void> => {
    if (!owned) return
    if (def && installed === false) { setError(t('play.notInstalled')); return }
    const r = await play(owned.id)
    if (!r.ok && r.error === 'otherRunning') {
      const otherId = useEmulators.getState().running.find((id) => id !== owned.id)
      const other = otherId !== undefined ? useLibrary.getState().entries.find((e) => e.id === otherId) : undefined
      if (otherId !== undefined) { setConfirmStop({ otherId, title: other?.title ?? '' }); return }
    }
    setError(r.ok ? null : t(`play.${r.error ?? 'spawn'}`) + (r.detail && r.error === 'spawn' ? ` (${r.detail})` : ''))
  }
  const stopOtherAndLaunch = async (): Promise<void> => {
    if (!confirmStop) return
    await window.api.invoke('game:stopAndWait', confirmStop.otherId)
    setConfirmStop(null)
    await launch()
  }
  const playable = owned && !owned.missing
  const downloadable = (!owned || owned.missing) && sources.length > 0
  const startDl = async (id: number): Promise<void> => {
    if (useDownloads.getState().jobs[id]) return
    setSourceId(id)
    setError(null)
    const r = await startDownload(id, title)
    if (r.ok) await useLibrary.getState().refresh()
  }
  const clickDownload = (): void => {
    if (sources.length > 1) setPickingSource(true)
    else if (sources[0]) void startDl(sources[0].id)
  }
  return (
    <div className="bp-overlay">
      <div className="bp-detail" data-focus-root>
        {gameId !== null
          ? <Cover className="bp-detail-cover" gameId={gameId} title={title} kind="tile" />
          : <div className="bp-detail-cover" style={artStyle(title)} />}
        <div className="bp-detail-body">
          <h2>{title}</h2>
          <div className="muted"><Badge>{label(cons)}</Badge>{owned && ` ${t('bp.played', { n: owned.playMinutes })}`}</div>
          <div className="muted">{[year && t('game.released', { d: String(year) }), details?.publisher && t('game.publishedBy', { p: details.publisher }), developer && t('game.developedBy', { p: developer })].filter(Boolean).join(' · ')}</div>
          {genres.length > 0 && <div className="tags">{genres.map((g) => <Tag key={g}>{g}</Tag>)}</div>}
          {/* Pas de data-nav : texte informatif seulement, déjà défilable au stick droit (cf. scrollWithRightStick) sans jamais recevoir le focus. */}
          {details?.summary && <div className="bp-summary" data-scroll>{details.summary}</div>}
          {(error || dlError) && <div className="bp-error">{error ?? `${t('download.failedHeader')} ${dlError}`}</div>}
          <div className="bp-actions">
            {playable && (running
              ? <button data-nav className="bp-btn primary" onClick={() => void window.api.invoke('game:stop', owned.id)}>■ {t('play.stop')}</button>
              : <button data-nav className="bp-btn primary" onClick={() => void launch()}>▶ {t('play')}</button>)}
            {!owned && gameId !== null && <button data-nav className="bp-btn primary" onClick={() => void useLibrary.getState().add(gameId)}>+ {t('addToLibrary')}</button>}
            {downloadable && (downloading
              ? <button data-nav className="bp-btn" onClick={() => sourceId !== undefined && cancelDownload(sourceId)}>
                  {job && job.total > 0 ? `${t('download.cancel')} (${Math.round((job.done / job.total) * 100)}%)` : job?.message === 'connecting' ? t('download.connecting') : t('download.downloading')}
                </button>
              : <button data-nav className="bp-btn primary" onClick={clickDownload}>⬇ {t('download.button')}</button>)}
            {owned && <button data-nav className="bp-btn" onClick={() => void useLibrary.getState().setFlag(owned.id, { favorite: !owned.favorite })}>{owned.favorite ? '♥' : '♡'} {t(owned.favorite ? 'fav.remove' : 'fav.add')}</button>}
            {owned?.missing && <span className="muted">{t('game.noFile')}</span>}
            <button data-nav className="bp-btn" onClick={onClose}>{t('bp.back')}</button>
          </div>
          {/* B (retour) et X (favoris) agissent tout de suite en plus des boutons ci-dessus, sans devoir y amener le focus : cf. le gestionnaire `opened` dans BigPicture.tsx. Pas d'indice ici (redondant avec les boutons visibles). */}
        </div>
      </div>
      {confirmStop && (
        <div className="bp-overlay">
          <div className="bp-menu" data-focus-root>
            <p>{t('play.confirmStopOther', { title: confirmStop.title })}</p>
            <button data-nav className="bp-btn" onClick={() => setConfirmStop(null)}>{t('dialog.cancel')}</button>
            <button data-nav className="bp-btn primary" onClick={() => void stopOtherAndLaunch()}>{t('play.confirmStopOtherYes')}</button>
          </div>
        </div>
      )}
      {pickingSource && (
        <div className="bp-overlay">
          <div className="bp-menu bp-source-picker" data-focus-root>
            <p>{t('download.choose')}</p>
            {sources.map((s) => (
              <button key={s.id} data-nav className="bp-btn" onClick={() => { setPickingSource(false); void startDl(s.id) }}>
                {s.title}{s.sizeBytes ? ` · ${formatSize(s.sizeBytes)}` : ''}{isTorrentSource(s.uris) && <span className="tag tag-p2p">{t('download.torrentTag')}</span>}
              </button>
            ))}
            <button data-nav className="bp-btn" onClick={() => setPickingSource(false)}>{t('dialog.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
