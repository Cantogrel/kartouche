import { useEffect, useMemo } from 'react'
import { Button, Section } from '@/ui'
import { EntryCard } from '@/ui/EntryCard'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import type { LibraryEntry } from '@shared/library'

const ROW = 6

const row = (list: LibraryEntry[]) => <div className="grid">{list.map((g) => <EntryCard key={g.id} entry={g} />)}</div>

/** Accueil : reprise des parties, favoris, ajouts récents et collections, à partir de la vraie bibliothèque. */
export function Home() {
  const go = useApp((s) => s.go)
  const { entries, collections, loaded, refresh } = useLibrary()
  useEffect(() => { void refresh() }, [refresh])
  const { played, favorites, recent, minutes } = useMemo(() => ({
    played: entries.filter((e) => e.lastPlayed && !e.missing).sort((a, b) => b.lastPlayed! - a.lastPlayed!),
    favorites: entries.filter((e) => e.favorite),
    recent: [...entries].sort((a, b) => b.addedAt - a.addedAt),
    minutes: entries.reduce((n, e) => n + e.playMinutes, 0)
  }), [entries])

  if (loaded && entries.length === 0) {
    return <div className="content"><p className="empty">{t('home.empty')}</p><p style={{ textAlign: 'center' }}><Button variant="primary" onClick={() => go('library')}>{t('home.toLibrary')}</Button></p></div>
  }
  return (
    <div className="content">
      <p className="muted home-stats">{t('home.stats', { n: entries.length, h: Math.round(minutes / 60) })}</p>
      {played.length > 0 && <Section title={t('home.continue')}>{row(played.slice(0, ROW))}</Section>}
      {favorites.length > 0 && <Section title={t('home.favorites')}>{row(favorites.slice(0, ROW))}</Section>}
      {recent.length > 0 && <Section title={t('home.recent')}>{row(recent.slice(0, ROW))}</Section>}
      {collections.map((c) => {
        const list = entries.filter((e) => e.collections.includes(c.id))
        return list.length > 0 ? <Section key={c.id} title={c.name}>{row(list.slice(0, ROW))}</Section> : null
      })}
    </div>
  )
}
