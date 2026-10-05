import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { useLibrary } from '@/store/library'
import { useSettings } from '@/store/settings'
import { formatMinutes, formatSize } from '@shared/format'
import type { GameStats, LibraryEntry } from '@shared/library'
import { Section } from './Section'

/** Statistiques d'un jeu de la bibliothèque (temps de jeu, sessions, rang, taille…) ; se recharge quand la liste est rechargée (fin de partie, import…). */
export function StatsPanel({ entry }: { entry: LibraryEntry }) {
  const [stats, setStats] = useState<GameStats | null>(null)
  const rev = useLibrary((s) => s.rev)
  const lang = useSettings((s) => s.lang)
  useEffect(() => {
    let off = false
    void window.api.invoke('library:stats', entry.id).then((s) => { if (!off) setStats(s) })
    return () => { off = true }
  }, [entry.id, entry.playMinutes, entry.lastPlayed, rev])
  if (!stats) return null
  const date = (ts: number | null): string => (ts === null ? t('stats.never') : new Date(ts).toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' }))
  const rows: [string, string][] = [
    [t('stats.playTime'), formatMinutes(stats.playMinutes)],
    ...(stats.sessions > 0 ? [
      [t('stats.sessions'), String(stats.sessions)],
      [t('stats.average'), formatMinutes(stats.averageSessionMinutes)],
      [t('stats.longest'), formatMinutes(stats.longestSessionMinutes)]
    ] as [string, string][] : []),
    ...(stats.last7DaysMinutes > 0 || stats.last30DaysMinutes > 0 ? [
      [t('stats.last7'), formatMinutes(stats.last7DaysMinutes)],
      [t('stats.last30'), formatMinutes(stats.last30DaysMinutes)]
    ] as [string, string][] : []),
    [t('stats.lastPlayed'), date(stats.lastPlayed)],
    ...(stats.rank !== null ? [[t('stats.rank'), t('stats.rankValue', { r: stats.rank, n: stats.playedGames })]] as [string, string][] : []),
    [t('stats.added'), date(stats.addedAt)],
    ...(stats.sizeBytes > 0 ? [[t('stats.size'), formatSize(stats.sizeBytes)]] as [string, string][] : [])
  ]
  return (
    <Section id="stats" title={t('stats.title')}>
      {stats.playMinutes === 0 && <p className="muted stats-none">{t('stats.none')}</p>}
      <dl className="stats-grid">
        {rows.map(([k, v]) => <div key={k} className="stats-row"><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </Section>
  )
}
