import { Badge, Cover, GameCard } from '@/ui'
import { useApp } from '@/store/app'
import { onEntryContext } from '@/ui/EntryMenu'
import { consoleById } from '@shared/consoles'
import type { LibraryEntry } from '@shared/library'

/** Carte d'un jeu de la bibliothèque : ouvre sa fiche, menu au clic droit, cœur si favori, grisée sans fichier. */
export function EntryCard({ entry: g }: { entry: LibraryEntry }) {
  const go = useApp((s) => s.go)
  const label = consoleById(g.console)?.label ?? g.console
  const open = (): void => go('game', `lib:${g.id}`)
  return g.gameId === null ? (
    <div className="fav-wrap" onContextMenu={onEntryContext(g.id)}>
      <GameCard title={g.title} console={label} hasFile={!g.missing} onClick={open} />
      {g.favorite && <span className="fav-mark">♥</span>}
    </div>
  ) : (
    <div className={`card${g.missing ? ' nofile' : ''}`} role="button" tabIndex={0} aria-label={`${g.title} (${label})`} onClick={open} onContextMenu={onEntryContext(g.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}>
      <Cover className="cover-fill" gameId={g.gameId} title={g.title} kind="tile"><span className="card-title">{g.title}</span><Badge>{label}</Badge></Cover>
      {g.favorite && <span className="fav-mark">♥</span>}
    </div>
  )
}
