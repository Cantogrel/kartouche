import { Badge, Cover, GameCard } from '@/ui'
import { useApp } from '@/store/app'
import { useGameDownloadPercent } from '@/store/downloads'
import { onEntryContext } from '@/ui/EntryMenu'
import { consoleById } from '@shared/consoles'
import type { LibraryEntry } from '@shared/library'

/** Voile clair qui se remplit sur toute la hauteur/largeur de l'élément parent (positionné) selon l'avancement du téléchargement. */
export function DownloadVeil({ gameId }: { gameId: number | null }) {
  const percent = useGameDownloadPercent(gameId)
  if (percent === undefined) return null
  return <span className={`dl-veil${percent === null ? ' indeterminate' : ''}`} style={percent === null ? undefined : { width: `${percent}%` }} aria-hidden />
}

/** Carte d'un jeu de la bibliothèque : ouvre sa fiche, menu au clic droit, cœur si favori, étoile si épinglé, grisée sans fichier. */
export function EntryCard({ entry: g }: { entry: LibraryEntry }) {
  const go = useApp((s) => s.go)
  const label = consoleById(g.console)?.label ?? g.console
  const open = (): void => go('game', `lib:${g.id}`)
  return g.gameId === null ? (
    <div className="fav-wrap" onContextMenu={onEntryContext(g.id)}>
      <GameCard title={g.title} console={label} hasFile={!g.missing} onClick={open} />
      {g.favorite && <span className="fav-mark">♥</span>}
      {g.pinned && <span className="pin-mark">★</span>}
    </div>
  ) : (
    <div className={`card${g.missing ? ' nofile' : ''}`} role="button" tabIndex={0} aria-label={`${g.title} (${label})`} onClick={open} onContextMenu={onEntryContext(g.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}>
      <Cover className="cover-fill" gameId={g.gameId} title={g.title} kind="tile"><span className="card-title">{g.title}</span><Badge>{label}</Badge></Cover>
      <DownloadVeil gameId={g.gameId} />
      {g.favorite && <span className="fav-mark">♥</span>}
      {g.pinned && <span className="pin-mark">★</span>}
    </div>
  )
}
