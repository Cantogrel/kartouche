import { useEffect, useMemo } from 'react'
import { Button, Section } from '@/ui'
import { EntryCard } from '@/ui/EntryCard'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import { visibleHomeSections } from '@shared/homeLayout'
import type { LibraryEntry } from '@shared/library'

const ROW = 6

const row = (list: LibraryEntry[]) => <div className="grid">{list.map((g) => <EntryCard key={g.id} entry={g} />)}</div>

/** Accueil : blocs (reprise, favoris, ajouts récents, collections, stats) dans l'ordre choisi par l'utilisateur. */
export function Home() {
  const go = useApp((s) => s.go)
  const layout = useSettings((s) => s.settings.homeLayout)
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
      {visibleHomeSections(layout).map((s) => {
        switch (s) {
          case 'stats': return <p key={s} className="muted home-stats">{t('home.stats', { n: entries.length, h: Math.round(minutes / 60) })}</p>
          case 'continue': return played.length > 0 ? <Section key={s} title={t('home.continue')}>{row(played.slice(0, ROW))}</Section> : null
          case 'favorites': return favorites.length > 0 ? <Section key={s} title={t('home.favorites')}>{row(favorites.slice(0, ROW))}</Section> : null
          case 'recent': return recent.length > 0 ? <Section key={s} title={t('home.recent')}>{row(recent.slice(0, ROW))}</Section> : null
          case 'collections': return collections.map((c) => {
            const list = entries.filter((e) => e.collections.includes(c.id))
            return list.length > 0 ? <Section key={`c${c.id}`} title={c.name}>{row(list.slice(0, ROW))}</Section> : null
          })
        }
      })}
    </div>
  )
}
