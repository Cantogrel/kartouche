import { useCallback, useEffect, useRef, useState } from 'react'
import { FilterGroup, Tag, Badge, Cover, Button } from '@/ui'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { CONSOLES, consoleById } from '@shared/consoles'
import type { CatalogPage, CatalogSort, SyncProgress } from '@shared/catalog'

const PAGE = 60
const toggle = (arr: string[], v: string): string[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
const labelOf = (id: string): string => consoleById(id)?.label ?? id

export function Catalog({ query }: { query: string }) {
  const { go } = useApp()
  const [consoles, setConsoles] = useState<string[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [sort, setSort] = useState<CatalogSort>('popularity')
  const [variants, setVariants] = useState(false)
  const [page, setPage] = useState<CatalogPage | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [status, setStatus] = useState<{ total: number; syncing: boolean } | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const reqId = useRef(0)

  const refreshStatus = useCallback(() => window.api.invoke('catalog:status').then(setStatus), [])
  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useEffect(() => window.api.on('catalog:progress', setProgress), [])

  // Une nouvelle recherche invalide les réponses plus lentes encore en vol.
  useEffect(() => {
    const id = ++reqId.current
    const h = setTimeout(() => {
      window.api.invoke('catalog:search', { q: query, consoles, genres, sort, limit, includeVariants: variants })
        .then((p) => { if (id === reqId.current) setPage(p) })
    }, 150)
    return () => clearTimeout(h)
  }, [query, consoles, genres, sort, limit, variants, status?.total])
  useEffect(() => setLimit(PAGE), [query, consoles, genres, sort, variants])

  const sync = async (): Promise<void> => {
    setStatus((s) => ({ total: s?.total ?? 0, syncing: true }))
    await window.api.invoke('catalog:sync', undefined)
    setProgress(null)
    await refreshStatus()
  }

  // Premier lancement : catalogue vide → synchronisation automatique.
  const auto = useRef(false)
  useEffect(() => {
    if (status && status.total === 0 && !status.syncing && !auto.current) { auto.current = true; void sync() }
  }, [status])

  const games = page?.games ?? []
  const consoleOpts = CONSOLES.map((c) => c.id)
  return (
    <div className="content catalog">
      <div className="catalog-list">
        {(status?.syncing || progress) && (
          <div className="panel catalog-sync"><span>{t('catalog.syncing', { n: progress?.done ?? 0, total: progress?.total ?? CONSOLES.length })}</span></div>
        )}
        <div className="toolbar">
          <div>
            <strong>{page?.total ?? 0} {t('results')}</strong>
            <div className="muted">{t('refine')}</div>
          </div>
          <div className="row">
            <Button onClick={sync} disabled={status?.syncing}>{t('catalog.refresh')}</Button>
            <label className="row">{t('sortBy')}
              <select value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)}>
                <option value="popularity">{t('sort.popularity')}</option>
                <option value="title">{t('sort.title')}</option>
                <option value="year">{t('sort.year')}</option>
              </select>
            </label>
          </div>
        </div>
        {status && status.total === 0 && !status.syncing && <p className="muted">{t('catalog.empty')}</p>}
        {games.map((g) => (
          <div key={g.id} className="row-card" tabIndex={0} onClick={() => go('game', String(g.id))} onKeyDown={(e) => e.key === 'Enter' && go('game', String(g.id))}>
            <Cover className="thumb" consoleId={g.console} title={g.title}><Badge>{labelOf(g.console)}</Badge></Cover>
            <div>
              <div className="title">{g.title}</div>
              <div className="muted">{[g.genre, g.year, g.developer].filter(Boolean).join(' · ')}</div>
              <div className="tags">{g.region && <Tag>{g.region}</Tag>}</div>
            </div>
          </div>
        ))}
        {page && page.total > games.length && <Button onClick={() => setLimit(limit + PAGE)}>{t('catalog.more')}</Button>}
      </div>
      <aside className="filters">
        <FilterGroup title={t('filter.console')} count={consoleOpts.length} options={consoleOpts} selected={consoles}
          format={(id) => `${labelOf(id)} (${page?.consoles.find((c) => c.id === id)?.count ?? 0})`} onToggle={(o) => setConsoles(toggle(consoles, o))} />
        <FilterGroup title={t('filter.genre')} count={page?.genres.length ?? 0} options={(page?.genres ?? []).map((g) => g.name)} selected={genres}
          format={(n) => `${n} (${page?.genres.find((g) => g.name === n)?.count ?? 0})`} onToggle={(o) => setGenres(toggle(genres, o))} />
        <label className="check"><input type="checkbox" checked={variants} onChange={(e) => setVariants(e.target.checked)} /> {t('catalog.variants')}</label>
      </aside>
    </div>
  )
}
