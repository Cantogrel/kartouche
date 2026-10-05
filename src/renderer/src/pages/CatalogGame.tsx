import { useEffect, useState } from 'react'
import { Button, Cover, Tag } from '@/ui'
import { useApp } from '@/store/app'
import { t } from '@/i18n'
import { platformLabel } from '@shared/consoles'
import { canonicalGenre, genreLabel } from '@shared/genres'
import { formatSize } from '@shared/format'
import { isTorrentSource } from '@shared/uriKind'
import { useSettings } from '@/store/settings'
import type { CatalogGame, GameDetails } from '@shared/catalog'
import type { LibraryEntry } from '@shared/library'
import type { GameSource } from '@shared/sourceList'
import { useLibrary } from '@/store/library'
import { useEntryOverrides } from '@/store/overrides'
import { useDialog } from '@/ui/CollectionDialogs'
import { MediaSections, useGameMedia } from '@/ui/GameMedia'
import { defaultBackgroundId, igdbImageUrl } from '@shared/media'
import { PlayWithButton } from '@/ui/PlayWith'
import { Section } from '@/ui/Section'
import { StatsPanel } from '@/ui/GameStats'
import { baseViewFrom, resolveView, splitGenres } from '@shared/overrides'
import { useDownloads } from '@/store/downloads'
import { openEntryMenuAt } from '@/ui/EntryMenu'
import { OpenEmulatorButton, PlayButton, QuickExitNotice } from '@/ui/PlayButton'
import { AchievementsPanel, ContentPanel, FlagButtons, SavesPanel, UninstallButton } from '@/ui/GameExtras'

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
    void window.api.invoke('catalog:get', id).then(setGame)
    void window.api.invoke('catalog:details', { id }).then(setDetails).finally(() => setLoadingDetails(false))
    void window.api.invoke('sources:forGame', id).then(setSources)
  }, [id])
  // Fiche ouverte depuis la bibliothèque (`entry`) : les modifications de l'utilisateur s'appliquent. Depuis le catalogue, la fiche reste celle d'origine.
  const overrides = useEntryOverrides(entry)
  const media = useGameMedia(game ? game.id : null)
  // Fond : celui de l'utilisateur, sinon une image IGDB du jeu (jamais la bannière, qui passerait derrière sans se voir).
  const defaultBg = defaultBackgroundId(media, false)
  const backdropUrl = entry?.art.background ? `kimg://custom/${entry.art.background}` : defaultBg ? igdbImageUrl(defaultBg, 't_1080p') : null
  useEffect(() => { if (game) setPageTitle(entry ? entry.shownTitle : game.name) }, [game, entry?.shownTitle, setPageTitle])
  if (game === undefined) return null
  if (game === null) return <div className="content"><p className="muted">{t('game.notFound')}</p></div>
  // Les données du catalogue sont propres à la plateforme (année de sortie sur cette console) : elles passent avant celles de la fiche.
  const view = entry ? resolveView(baseViewFrom(game, details, game.name), overrides) : null
  const shownName = view?.title ?? game.name
  const year = view ? view.year ?? undefined : game.year ?? details?.releaseYear
  const developer = view ? view.developer ?? undefined : game.developer ?? details?.developer
  const summary = view ? view.description ?? undefined : details?.summary
  const summaryIsMine = !!entry && overrides.description !== undefined
  // Genre principal du catalogue d'abord, puis ceux de la fiche (dédoublonnés après traduction).
  const genres = entry && overrides.genre !== undefined ? splitGenres(overrides.genre).map((g) => genreLabel(g, lang)) : [...new Set([game.genre, ...(details?.genres ?? []).map((g) => canonicalGenre(g))].filter((g): g is string => !!g))].map((g) => genreLabel(g, lang))
  return (
    <div className="content nopad detail-page">
      {backdropUrl && <div className="detail-backdrop" aria-hidden style={{ backgroundImage: `url(${backdropUrl})` }} />}
      <Cover className="hero" kind="hero" gameId={game.id} art={entry?.art.banner} title={shownName}>
        <div className="hero-title">{shownName}</div>
        <div className="hero-bar">
          <strong>{platformLabel(game.console)}</strong>
          <div className="row">
            {!owned && <Button variant="primary" onClick={() => void addToLibrary(game.id)}>{t('addToLibrary')}</Button>}
            {owned?.missing && <Button variant="primary" onClick={() => void link()}>{t('linkRom')}</Button>}
            {(!owned || owned.missing) && sources.length > 0 && <DownloadButton sources={sources} gameName={game.name} gameId={game.id} />}
            {owned && !owned.missing && <PlayButton entry={owned} />}
            {owned && !owned.missing && <PlayWithButton entry={owned} />}
            {owned && !owned.missing && <OpenEmulatorButton entry={owned} />}
            {owned && !owned.missing && sources.length > 0 && <UninstallButton entry={owned} />}
            {owned && <FlagButtons entry={owned} />}
            {entry && <Button onClick={() => useDialog.getState().open({ kind: 'edit', entryId: entry.id })}>{t('edit.button')}</Button>}
            {owned && <Button onClick={(e) => openEntryMenuAt(e, owned.id, { edit: !!entry })}>⚙ {t('options')}</Button>}
          </div>
        </div>
      </Cover>
      <div className="detail">
        <DownloadFailureNotice sources={sources} />
        {owned && !owned.missing && <QuickExitNotice entryId={owned.id} />}
        <div className="detail-grid">
          <div className="detail-main">
            {(loadingDetails && !details) || summary ? (
              <Section id="about" title={t('game.about')}>
                {loadingDetails && !details && !summary && <><span className="skeleton" style={{ width: '90%' }} /><span className="skeleton" style={{ width: '80%' }} /><span className="skeleton" style={{ width: '55%' }} /></>}
                {summary && (<><p className="about-text">{summary}</p>{!summaryIsMine && details && <p className="muted">{details.summarySource === 'wikipedia' ? t('game.summaryWikipedia') : details.summarySource === 'machine' ? t('game.summaryMachine') : t('game.source', { p: details.provider.split('+')[0].toUpperCase() })}</p>}</>)}
              </Section>
            ) : null}
            <MediaSections media={media} />
          </div>
          <div className="detail-side">
            <Section id="info" title={t('info.title')}>
              {year && <div><strong>{t('game.released', { d: String(year) })}</strong></div>}
              <div className="muted">{[details?.publisher && t('game.publishedBy', { p: details.publisher }), developer && t('game.developedBy', { p: developer })].filter(Boolean).join(' \u00b7 ')}</div>
              <div className="tags">{genres.map((x) => <Tag key={x}>{x}</Tag>)}<Tag>{platformLabel(game.console)}</Tag></div>
              {owned && <LibraryFile entry={owned} />}
            </Section>
            {owned && <StatsPanel entry={owned} />}
            {owned && !owned.missing && <SavesPanel entry={owned} />}
            {owned && <ContentPanel entry={owned} />}
            {owned && !owned.missing && <AchievementsPanel entry={owned} />}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Télécharge une source choisie par l'utilisateur (Paramètres → Sources, P03-S1), puis vérifie son hash contre le
 * jeu attendu et l'installe dans la bibliothèque (P05) — jamais d'installation silencieuse si le hash ne correspond pas.
 */
function DownloadButton({ sources, gameName, gameId }: { sources: GameSource[]; gameName: string; gameId: number }) {
  const [picked, setPicked] = useState(sources[0]?.id)
  // Le téléchargement vit dans le store global : à la réouverture de la fiche, la sélection locale retombe sur la 1re source,
  // alors que le job en cours peut porter sur une autre — la source active prime tant qu'il tourne.
  const activeId = useDownloads((s) => sources.find((x) => s.jobs[x.id])?.id)
  const selected = activeId ?? picked
  const setSelected = setPicked
  const job = useDownloads((s) => (selected !== undefined ? s.jobs[selected] : undefined))
  const startDownload = useDownloads((s) => s.start)
  const cancelDownload = useDownloads((s) => s.cancel)
  const busy = job?.phase === 'downloading'

  const start = async (): Promise<void> => {
    if (selected === undefined || busy) return
    const r = await startDownload(selected, gameName, gameId)
    if (r.ok) await useLibrary.getState().refresh()
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
              {s.title}{!sameList ? ` · ${s.listName}` : ''}{s.sizeBytes ? ` · ${formatSize(s.sizeBytes)}` : ''}{isTorrentSource(s.uris) ? ` · ${t('download.torrentTag')}` : ''}
            </option>
          ))}
        </select>
      )}
      <div className="dl-col">
        {isTorrentSource(sources.find((s) => s.id === selected)?.uris ?? []) && <Tag className="tag-p2p">{t('download.torrentTag')}</Tag>}
      {busy
        // Juste après le clic, avant la première mesure réelle (comme « Lancement… » sur le bouton Jouer) : pas encore annulable.
        ? (percent !== null
            ? <Button onClick={cancel}>{t('download.cancel')} ({percent} %)</Button>
            : job?.message === 'connecting'
              // Torrent : recherche de pairs/métadonnées (jusqu'à 2 min), annulable contrairement au court instant avant la 1re mesure HTTP.
              ? <Button onClick={cancel}>{t('download.connecting')}</Button>
              : <Button disabled>{t('download.downloading')}</Button>)
        : <Button variant="primary" onClick={() => void start()}>{t('download.button')}{sources.length === 1 && sources[0].sizeBytes ? ` · ${formatSize(sources[0].sizeBytes)}` : ''}</Button>}
      </div>
    </div>
  )
}

/** Échec de téléchargement : même vitrine que l'échec d'un lancement (QuickExitNotice) — panneau en tête de page, message, copie, fermeture. */
function DownloadFailureNotice({ sources }: { sources: GameSource[] }) {
  const errors = useDownloads((s) => s.errors)
  const dismiss = useDownloads((s) => s.dismissError)
  const [copied, setCopied] = useState(false)
  const failed = sources.filter((s) => errors[s.id] !== undefined)
  if (!failed.length) return null
  const copy = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* presse-papier indisponible */ }
  }
  return (
    <>
      {failed.map((s) => (
        <div key={s.id} className="panel quick-exit">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>{t('download.failedHeader')}</div>
            <Button variant="icon" title={t('play.dismiss')} aria-label={t('play.dismiss')} onClick={() => dismiss(s.id)}>✕</Button>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
            <strong>{errors[s.id]}</strong>
            <Button onClick={() => void copy(errors[s.id])}>{copied ? t('play.copied') : t('play.copyLog')}</Button>
          </div>
        </div>
      ))}
    </>
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
