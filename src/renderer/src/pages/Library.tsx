import { GameCard } from '@/ui'
import { t } from '@/i18n'

const demo = [
  { title: 'Super Mario World', console: 'SNES', hasFile: true, progress: 42 },
  { title: 'Metroid Prime', console: 'GameCube', hasFile: true, progress: 10 },
  { title: 'Final Fantasy VII', console: 'PS1', hasFile: false },
  { title: 'Zelda: Ocarina of Time', console: 'N64', hasFile: true, progress: 78 }
]
export function Library() {
  return (
    <div className="content">
      <div className="grid">{demo.map((g) => <GameCard key={g.title} {...g} />)}</div>
      <p className="empty">{t('library.empty')} (demo)</p>
    </div>
  )
}
