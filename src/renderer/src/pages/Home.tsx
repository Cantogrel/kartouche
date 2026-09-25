import { GameCard, Section } from '@/ui'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { DEMO_GAMES } from '@/data/demo'

export function Home() {
  const { go } = useApp()
  const owned = DEMO_GAMES.filter((g) => g.inLibrary)
  const played = owned.filter((g) => g.lastPlayedDays !== null && g.hasFile).sort((a, b) => a.lastPlayedDays! - b.lastPlayedDays!)
  const row = (list: typeof owned) => (
    <div className="grid">{list.map((g) => (
      <GameCard key={g.id} title={g.title} console={g.console} hasFile={g.hasFile} progress={g.progress} onClick={() => go('game', g.id)} />
    ))}</div>
  )
  return (
    <div className="content">
      <Section title={t('home.continue')}>{row(played.slice(0, 4))}</Section>
      <Section title={t('home.recent')}>{row(owned.slice(-4))}</Section>
    </div>
  )
}
