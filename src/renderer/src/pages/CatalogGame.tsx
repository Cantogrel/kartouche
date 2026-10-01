import { useEffect, useState } from 'react'
import { Button, Cover, Tag } from '@/ui'
import { useApp } from '@/store/app'
import { t } from '@/i18n'
import { consoleById } from '@shared/consoles'
import { canonicalGenre, genreLabel } from '@shared/genres'
import { formatSize } from '@shared/format'
import { useSettings } from '@/store/settings'
import type { CatalogGame, GameDetails } from '@shared/catalog'
import type { LibraryEntry } from '@shared/library'
import type { GameSource } from '@shared/sourceList'
import { useLibrary } from '@/store/library'
import { useDownloads } from '@/store/downloads'
import { openEntryMenuAt } from '@/ui/EntryMenu'
import { OpenEmulatorButton, PlayButton, QuickExitNotice } from '@/ui/PlayButton'
import { AchievementsPanel, ContentPanel, FlagButtons, SavesPanel } from '@/ui/GameExtras'

/** Fiche d'un jeu du catalogue : données du DAT + description enrichie si un fournisseur (IGDB) est configuré. */
export function CatalogGameDetail({ id, entry }: { id: number; entry?: LibraryEntry }) {
  const inLibrary = useLibrary((s) => s.entries.find((e) => e.gameId === id))
  const owned = entry ?? inLibrary
  const [game, setGame] = useState<CatalogGame | null | undefined>(undefined)
  const [details, setDetails] = useState<GameDetails | null>(null)
  const [loadingDetails, setLoadingDetails] = useState(true)
  const [sources, setSources] = useState<GameSource[]>([])
  const setPageTitle = useApp((s) => s.setPageTitle)
  const { add: addToLibrary, link } = useLibrary.getState()
  useEffect(() => { void useLibrary.getState().refresh() }, [])
  const lang = useSettings((s) => s.lang)
  useEffect(() => {
    setGame(undefined); setDetails(null); setLoadingDetails(true); setSources([])
    void window.api.invoke('catalog:get', id).then((g) => { setGame(g); setPageTitle(g?.name ?? null) })
    void window.api.invoke('catalog:details', { id }).then(setDetails).finally(() => setLoadingDetails(false))
    void window.api.invoke('sources:forGame', id).then(setSources)
  }, [id, setPageTitle])
  if (game === undefined) return null
  if (game === null) return <div className="content"><p className="muted">{t('game.notFound')}</p></div>
  // Les données du catalogue sont propres à la plateforme (année de sortie sur cette console) : elles passent avant celles de la fiche.
  const year = game.year ?? details?.releaseYear
  const developer = game.developer ?? details?.developer
  // Genre principal du catalogue d'abord, puis ceux de la fiche (dédoublonnés après traduction).
  const genres = [...new Set([game.genre, ...(details?.genres ?? []).map((g) => canonicalGenre(g))].filter((g): g is string => !!g))].map((g) => genreLabel(g, lang))
  return (
    <div className="content nopad">
      <Cover className="hero" kind="hero" gameId={game.id} title={game.name}>
        <div className="hero-title">{game.name}</div>
        <div className="hero-bar">
          <strong>{consoleById(game.console)?.label ?? game.console}</strong>
          <div className="row">
            {!owned && <Button variant="primary" onClick={() => void addToLibrary(game.id)}>{t('addToLibrary')}</Button>}
            {owned?.missing && <Button variant="primary" onClick={() => void link()}>{t('linkRom')}</Button>}
            {(!owned || owned.missing) && sources.length > 0 && <DownloadButton sources={sources} gameName={game.name} />}
            {owned && !owned.missing && <PlayButton entry={owned} />}
            {owned && !owned.missing && <OpenEmulatorButton entry={owned} />}
            {owned && <FlagButtons entry={owned} />}
            {owned && <Button onClick={(e) => openEntryMenuAt(e, owned.id)}>⚙ {t('options')}</Button>}
          </div>
        </div>
      </Cover>
      <div className="detail">
        {owned && !owned.missing && <QuickExitNotice entryId={owned.id} />}
        <div className="panel">
          {year && <div><strong>{t('game.released', { d: String(year) })}</strong></div>}
          <div className="muted">{[details?.publisher && t('game.publishedBy', { p: details.publisher }), developer && t('game.developedBy', { p: developer })].filter(Boolean).join(' · ')}</div>
          <div className="tags">{genres.map((x) => <Tag key={x}>{x}</Tag>)}<Tag>{consoleById(game.console)?.label ?? game.console}</Tag></div>
          {owned && <LibraryFile entry={owned} />}
          {loadingDetails && !details && <><span className="skeleton" style={{ width: '90%' }} /><span className="skeleton" style={{ width: '80%' }} /><span className="skeleton" style={{ width: '55%' }} /></>}
          {details?.summary && (<><h3>{t('game.about')}</h3><p>{details.summary}</p><p className="muted">{details.summarySource === 'wikipedia' ? t('game.summaryWikipedia') : details.summarySource === 'machine' ? t('game.summaryMachine') : t('game.source', { p: details.provider.split('+')[0].toUpperCase() })}</p></>)}
        </div>
        {owned && !owned.missing && <SavesPanel entry={owned} />}
        {owned && <ContentPanel entry={owned} />}
        {owned && !owned.missing && <AchievementsPanel entry={owned} />}
      </div>
    </div>
  )
}

/**
 * Télécharge une source choisie par l'utilisateur (Paramètres → Sources, P03-S1), puis vérifie son hash contre le
 * jeu attendu et l'installe dans la bibliothèque (P05) — jamais d'installation silencieuse si le hash ne correspond pas.
 */
function DownloadButton({ sources, gameName }: { sources: GameSource[]; gameName: string }) {
  const [selected, setSelected] = useState(sources[0]?.id)
  const [error, setError] = useState<string | null>(null)
  const job = useDownloads((s) => (selected !== undefined ? s.jobs[selected] : undefined))
  const startDownload = useDownloads((s) => s.start)
  const cancelDownload = useDownloads((s) => s.cancel)
  const busy = job?.phase === 'downloading'

  const start = async (): Promise<void> => {
    if (selected === undefined || busy) return
    setError(null)
    const r = await startDownload(selected, gameName)
    if (!r.ok) setError(r.error ?? null)
    else await useLibrary.getState().refresh()
  }
  const cancel = (): void => { if (selected !== undefined) cancelDownload(selected) }
  const percent = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : null
  // Plusieurs entrées d'une même liste n'ont souvent ni nom ni poids distincts : le titre brut de l'entrée
  // (convention No-Intro/Redump) porte lui la région/langues/révision qui les différencient vraiment.
  const sameList = sources.every((s) => s.listName === sources[0]?.listName)

  return (
    <div className="row">
      {sources.length > 1 && (
        <select value={selected} disabled={busy} onChange={(e) => setSelected(Number(e.target.value))}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}{!sameList ? ` · ${s.listName}` : ''}{s.sizeBytes ? ` · ${formatSize(s.sizeBytes)}` : ''}
            </option>
          ))}
        </select>
      )}
      {busy
        // Juste après le clic, avant la première mesure réelle (comme « Lancement… » sur le bouton Jouer) : pas encore annulable.
        ? (percent !== null
            ? <Button onClick={cancel}>{t('download.cancel')} ({percent} %)</Button>
            : <Button disabled>{t('download.downloading')}</Button>)
        : <Button variant="primary" onClick={() => void start()}>{t('download.button')}</Button>}
      {error && <span className="muted">{error}</span>}
    </div>
  )
}

/** Fichier associé à un jeu de la bibliothèque : emplacement et mode de reconnaissance. */
export function LibraryFile({ entry }: { entry: LibraryEntry }) {
  const days = entry.lastPlayed ? Math.floor((Date.now() - entry.lastPlayed) / 86400000) : null
  return (
    <div className="lib-file">
      {entry.missing
        ? <div className="muted">{t('game.noFile')}</div>
        : <><div className="muted">{entry.path}</div><div className="muted">{t(`match.${entry.match}`)} · {formatSize(entry.size)}</div></>}
      <div className="muted">{days === null ? t('game.neverPlayed') : t('game.lastPlayed', { n: days })}{entry.playMinutes > 0 && ` · ${t('game.playtime', { n: entry.playMinutes })}`}</div>
    </div>
  )
}
