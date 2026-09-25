import { useState } from 'react'
import { Button, GameCard, Pill } from '@/ui'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { DEMO_GAMES } from '@/data/demo'

type Tab = 'all' | 'ready' | 'missing'

export function Library() {
  const { go, librarySearch } = useApp()
  const [tab, setTab] = useState<Tab>('all')
  const q = librarySearch.trim().toLowerCase()
  const games = DEMO_GAMES.filter((g) => g.inLibrary)
    .filter((g) => (tab === 'ready' ? g.hasFile : tab === 'missing' ? !g.hasFile : true))
    .filter((g) => !q || g.title.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title))
  return (
    <div className="content">
      <div className="toolbar">
        <div className="row">
          {(['all', 'ready', 'missing'] as Tab[]).map((k) => <Pill key={k} active={tab === k} onClick={() => setTab(k)}>{t(`tab.${k}`)}</Pill>)}
        </div>
        <Button variant="primary">+ {t('addGame')}</Button>
      </div>
      {games.length === 0 ? <p className="empty">{t('library.empty')}</p> : (
        <div className="grid">
          {games.map((g) => (
            <GameCard key={g.id} title={g.title} console={g.console} hasFile={g.hasFile} progress={g.progress}
              minutes={g.playMinutes} onClick={() => go('game', g.id)} />
          ))}
        </div>
      )}
    </div>
  )
}
