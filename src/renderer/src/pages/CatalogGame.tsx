import { useEffect, useState } from 'react'
import { Button, Cover, Tag } from '@/ui'
import { useApp } from '@/store/app'
import { t } from '@/i18n'
import { consoleById } from '@shared/consoles'
import { canonicalGenre, genreLabel } from '@shared/genres'
import { useSettings } from '@/store/settings'
import type { CatalogGame, GameDetails } from '@shared/catalog'

/** Fiche d'un jeu du catalogue : données du DAT + description enrichie si un fournisseur (IGDB) est configuré. */
export function CatalogGameDetail({ id }: { id: number }) {
  const [game, setGame] = useState<CatalogGame | null | undefined>(undefined)
  const [details, setDetails] = useState<GameDetails | null>(null)
  const setPageTitle = useApp((s) => s.setPageTitle)
  const lang = useSettings((s) => s.lang)
  useEffect(() => {
    setGame(undefined); setDetails(null)
    void window.api.invoke('catalog:get', id).then((g) => { setGame(g); setPageTitle(g?.name ?? null) })
    void window.api.invoke('catalog:details', { id }).then(setDetails)
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
          <div className="row"><Button variant="primary" disabled>{t('addToLibrary')}</Button></div>
        </div>
      </Cover>
      <div className="detail">
        <div className="panel">
          {year && <div><strong>{t('game.released', { d: String(year) })}</strong></div>}
          <div className="muted">{[details?.publisher && t('game.publishedBy', { p: details.publisher }), developer && t('game.developedBy', { p: developer })].filter(Boolean).join(' · ')}</div>
          <div className="tags">{genres.map((x) => <Tag key={x}>{x}</Tag>)}<Tag>{consoleById(game.console)?.label ?? game.console}</Tag></div>
          {details?.summary && (<><h3>{t('game.about')}</h3><p>{details.summary}</p><p className="muted">{details.summarySource === 'wikipedia' ? t('game.summaryWikipedia') : details.summarySource === 'machine' ? t('game.summaryMachine') : t('game.source', { p: details.provider.split('+')[0].toUpperCase() })}</p></>)}
        </div>
      </div>
    </div>
  )
}
