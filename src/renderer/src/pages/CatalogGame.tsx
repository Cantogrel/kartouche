import { useEffect, useState } from 'react'
import { Button, Cover, Tag } from '@/ui'
import { t } from '@/i18n'
import { consoleById } from '@shared/consoles'
import type { CatalogGame, GameDetails } from '@shared/catalog'

/** Fiche d'un jeu du catalogue : données du DAT + description enrichie si un fournisseur (IGDB) est configuré. */
export function CatalogGameDetail({ id }: { id: number }) {
  const [game, setGame] = useState<CatalogGame | null | undefined>(undefined)
  const [details, setDetails] = useState<GameDetails | null>(null)
  useEffect(() => {
    setGame(undefined); setDetails(null)
    void window.api.invoke('catalog:get', id).then(setGame)
    void window.api.invoke('catalog:details', { id }).then(setDetails)
  }, [id])
  if (game === undefined) return null
  if (game === null) return <div className="content"><p className="muted">{t('game.notFound')}</p></div>
  const year = details?.releaseYear ?? game.year
  const developer = details?.developer ?? game.developer
  const genres = details?.genres?.length ? details.genres : game.genre ? [game.genre] : []
  return (
    <div className="content nopad">
      <Cover className="hero" consoleId={game.console} title={game.title} heroId={details?.heroUrl ? game.id : undefined}>
        <div className="hero-title">{game.title}</div>
        <div className="hero-bar">
          <strong>{consoleById(game.console)?.label ?? game.console}</strong>
          <div className="row"><Button variant="primary" disabled>{t('addToLibrary')}</Button></div>
        </div>
      </Cover>
      <div className="detail">
        <div className="panel">
          {year && <div><strong>{t('game.released', { d: String(year) })}</strong></div>}
          <div className="muted">{[details?.publisher && t('game.publishedBy', { p: details.publisher }), developer && t('game.developedBy', { p: developer })].filter(Boolean).join(' · ')}</div>
          <div className="tags">{genres.map((x) => <Tag key={x}>{x}</Tag>)}{game.region && <Tag>{game.region}</Tag>}</div>
          {details?.summary && (<><h3>{t('game.about')}</h3><p>{details.summary}</p><p className="muted">{t('game.source', { p: details.provider.toUpperCase() })}</p></>)}
        </div>
      </div>
    </div>
  )
}
