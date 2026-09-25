import { useMemo, useState } from 'react'
import { FilterGroup, Tag, artStyle, Badge } from '@/ui'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { CONSOLES, DEMO_GAMES, GENRES } from '@/data/demo'

type Sort = 'popularity' | 'title' | 'year'
const toggle = (arr: string[], v: string): string[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

export function Catalog({ query }: { query: string }) {
  const { go } = useApp()
  const [consoles, setConsoles] = useState<string[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [sort, setSort] = useState<Sort>('popularity')
  const q = query.trim().toLowerCase()

  const games = useMemo(() => {
    const list = DEMO_GAMES.filter((g) => (!consoles.length || consoles.includes(g.console))
      && (!genres.length || g.genres.some((x) => genres.includes(x))) && (!q || g.title.toLowerCase().includes(q)))
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title))
    if (sort === 'year') list.sort((a, b) => b.year - a.year)
    return list
  }, [consoles, genres, sort, q])

  return (
    <div className="content catalog">
      <div className="catalog-list">
        <div className="toolbar">
          <div>
            <strong>{games.length} {t('results')}</strong>
            <div className="muted">{t('refine')}</div>
          </div>
          <label className="row">{t('sortBy')}
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="popularity">{t('sort.popularity')}</option>
              <option value="title">{t('sort.title')}</option>
              <option value="year">{t('sort.year')}</option>
            </select>
          </label>
        </div>
        {games.map((g) => (
          <div key={g.id} className="row-card" tabIndex={0} onClick={() => go('game', g.id)} onKeyDown={(e) => e.key === 'Enter' && go('game', g.id)}>
            <div className="thumb" style={artStyle(g.title)}><Badge>{g.console}</Badge></div>
            <div>
              <div className="title">{g.title}</div>
              <div className="muted">{g.genres.join(', ')} · {g.year}</div>
              <div className="tags">{g.inLibrary && <Tag>{t('inLibrary')}</Tag>}</div>
            </div>
          </div>
        ))}
      </div>
      <aside className="filters">
        <FilterGroup title={t('filter.console')} count={CONSOLES.length} options={CONSOLES} selected={consoles} onToggle={(o) => setConsoles(toggle(consoles, o))} />
        <FilterGroup title={t('filter.genre')} count={GENRES.length} options={GENRES} selected={genres} onToggle={(o) => setGenres(toggle(genres, o))} />
      </aside>
    </div>
  )
}
