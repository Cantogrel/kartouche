import { useState } from 'react'
import { Button, Tag, artStyle } from '@/ui'
import { t } from '@/i18n'
import { DEMO_GAMES } from '@/data/demo'
import { CatalogGameDetail, LibraryFile } from './CatalogGame'
import { useLibrary } from '@/store/library'
import { openEntryMenuAt } from '@/ui/EntryMenu'
import { useApp } from '@/store/app'
import { useEffect } from 'react'

/** Les ids numériques viennent du catalogue ; les autres sont des jeux de démonstration (bibliothèque, Phase 4). */
export function GameDetail({ gameId }: { gameId?: string }) {
  if (gameId?.startsWith('lib:')) return <LibraryGameDetail entryId={Number(gameId.slice(4))} />
  if (gameId && /^[0-9]+$/.test(gameId)) return <CatalogGameDetail id={Number(gameId)} />
  return <DemoGameDetail gameId={gameId} />
}

/** Jeu de la bibliothèque : fiche du catalogue si le jeu est reconnu, sinon simple fiche de fichier. */
function LibraryGameDetail({ entryId }: { entryId: number }) {
  const { entries, loaded, refresh } = useLibrary()
  const setPageTitle = useApp((s) => s.setPageTitle)
  const entry = entries.find((e) => e.id === entryId)
  useEffect(() => { if (!loaded) void refresh() }, [loaded, refresh])
  useEffect(() => { if (entry) setPageTitle(entry.title) }, [entry, setPageTitle])
  if (!entry) return null
  if (entry.gameId !== null) return <CatalogGameDetail id={entry.gameId} entry={entry} />
  return <div className="content"><div className="panel"><h3>{entry.title}</h3><p className="muted">{t('match.none')}</p><LibraryFile entry={entry} /><div className="row" style={{ marginTop: 12 }}>{entry.missing && <Button variant="primary" onClick={() => void useLibrary.getState().link()}>{t('linkRom')}</Button>}<Button onClick={(e) => openEntryMenuAt(e, entry.id)}>⚙ {t('options')}</Button></div></div></div>
}

function DemoGameDetail({ gameId }: { gameId?: string }) {
  const game = DEMO_GAMES.find((g) => g.id === gameId)
  const [inLib, setInLib] = useState(game?.inLibrary ?? false)
  const [fav, setFav] = useState(false)
  const [pinned, setPinned] = useState(false)
  if (!game) return null
  return (
    <div className="content nopad">
      <div className="hero" style={artStyle(game.title)}>
        <div className="hero-title">{game.title}</div>
        <div className="hero-bar">
          <div>
            {inLib ? (
              <>
                <strong>{t('game.playtime', { n: game.playMinutes })}</strong>
                <div className="muted">{game.lastPlayedDays === null ? t('game.neverPlayed') : t('game.lastPlayed', { n: game.lastPlayedDays })}</div>
              </>
            ) : <strong>{game.console}</strong>}
          </div>
          <div className="row">
            {!inLib && <Button variant="primary" onClick={() => setInLib(true)}>{t('addToLibrary')}</Button>}
            {inLib && game.hasFile && <Button variant="primary">▶ {t('play')}</Button>}
            {inLib && !game.hasFile && <Button variant="primary">{t('linkRom')}</Button>}
            {inLib && <>
              <Button variant="icon" aria-label={t('favorite')} onClick={() => setFav(!fav)}>{fav ? '♥' : '♡'}</Button>
              <Button variant="icon" aria-label={t('pin')} onClick={() => setPinned(!pinned)}>{pinned ? '★' : '☆'}</Button>
              <Button>⚙ {t('options')}</Button>
            </>}
          </div>
        </div>
      </div>
      <div className="detail">
        <div className="panel">
          <div><strong>{t('game.released', { d: String(game.year) })}</strong></div>
          <div className="muted">{t('game.publishedBy', { p: game.publisher })} · {t('game.developedBy', { p: game.developer })}</div>
          <div className="tags">{game.genres.map((x) => <Tag key={x}>{x}</Tag>)}<Tag>{game.console}</Tag></div>
          <h3>{t('game.about')}</h3>
          <p>{game.description}</p>
          {inLib && !game.hasFile && <p className="muted">{t('game.noFile')}</p>}
        </div>
      </div>
    </div>
  )
}
