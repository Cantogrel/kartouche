import { useCallback, useEffect, useRef, useState } from 'react'
import { FilterGroup, Tag, Badge, Cover, Button } from '@/ui'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { useSettings } from '@/store/settings'
import { CONSOLES, MAKERS, consoleById } from '@shared/consoles'
import { genreLabel } from '@shared/genres'
import type { CatalogPage, CatalogSort, SyncProgress } from '@shared/catalog'

const PAGE = 60
const toggle = (arr: string[], v: string): string[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
const labelOf = (id: string): string => consoleById(id)?.label ?? id
const DEFAULT_DIR = { popularity: 'desc', year: 'desc', title: 'asc' } as const

export function Catalog({ query }: { query: string }) {
  const { go, catalog: view, setCatalog } = useApp()
  const { consoles, genres, sort, dir, variants, limit } = view
  const lang = useSettings((s) => s.lang)
  const effectiveDir = dir ?? DEFAULT_DIR[sort]
  const [page, setPage] = useState<CatalogPage | null>(null)
  const [status, setStatus] = useState<{ total: number; syncing: boolean; enriched: boolean } | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const reqId = useRef(0)
  // Survol d'une carte : la fiche est préparée (mise en cache côté principal) pour que le clic soit instantané.
  const prefetched = useRef(new Set<number>())
  const prefetch = (id: number): void => {
    if (prefetched.current.has(id)) return
    prefetched.current.add(id)
    void window.api.invoke('catalog:details', { id })
  }

  const refreshStatus = useCallback(() => window.api.invoke('catalog:status').then(setStatus), [])
  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useEffect(() => window.api.on('catalog:progress', setProgress), [])

  // Une nouvelle recherche invalide les réponses plus lentes encore en vol.
  useEffect(() => {
    const id = ++reqId.current
    const h = setTimeout(() => {
      window.api.invoke('catalog:search', { q: query, consoles, genres, sort, dir: effectiveDir, limit, includeVariants: variants })
        .then((p) => { if (id === reqId.current) setPage(p) })
    }, 150)
    return () => clearTimeout(h)
  }, [query, consoles, genres, sort, effectiveDir, limit, variants, status?.total, status?.enriched])

  // Tout changement de filtre ou de recherche (après le premier rendu) revient à la première page.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setCatalog({ limit: PAGE })
  }, [query, consoles, genres, sort, effectiveDir, variants, setCatalog])

  const sync = async (): Promise<void> => {
    setStatus((s) => ({ total: s?.total ?? 0, syncing: true, enriched: s?.enriched ?? false }))
    await window.api.invoke('catalog:sync', undefined)
    await window.api.invoke('catalog:popularity')
    setProgress(null)
    await refreshStatus()
  }

  // Premier lancement : catalogue vide → synchronisation automatique.
  const auto = useRef(false)
  useEffect(() => {
    if (status && status.total === 0 && !status.syncing && !auto.current) { auto.current = true; void sync() }
  }, [status])

  // Catalogue présent mais pas encore enrichi par IGDB (popularité, genre, année…) : passe unique, en arrière-plan.
  const rating = useRef(false)
  useEffect(() => {
    if (status && status.total > 0 && !status.enriched && !status.syncing && !rating.current) {
      rating.current = true
      void window.api.invoke('catalog:popularity').then(() => { setProgress(null); return refreshStatus() })
    }
  }, [status, refreshStatus])

  const games = page?.games ?? []
  return (
    <div className="content catalog">
      <div className="catalog-list">
        {(status?.syncing || progress) && (
          <div className="panel catalog-sync"><span>{progress?.console === 'popularity' ? t('catalog.rating', { n: progress.done, total: progress.total }) : t('catalog.syncing', { n: progress?.done ?? 0, total: progress?.total ?? CONSOLES.length })}</span></div>
        )}
        <div className="toolbar">
          <div>
            <strong>{page?.total ?? 0} {t('results')}</strong>
            <div className="muted">{t('refine')}</div>
          </div>
          <div className="row">
            <Button onClick={sync} disabled={status?.syncing}>{t('catalog.refresh')}</Button>
            <label className="row">{t('sortBy')}
              <select value={sort} onChange={(e) => setCatalog({ sort: e.target.value as CatalogSort, dir: null })}>
                <option value="popularity">{t('sort.popularity')}</option>
                <option value="title">{t('sort.title')}</option>
                <option value="year">{t('sort.year')}</option>
              </select>
            </label>
            <Button className="sortdir" aria-label={t(effectiveDir === 'asc' ? 'sort.asc' : 'sort.desc')} title={t(effectiveDir === 'asc' ? 'sort.asc' : 'sort.desc')}
              onClick={() => setCatalog({ dir: effectiveDir === 'asc' ? 'desc' : 'asc' })}>{effectiveDir === 'asc' ? '↑' : '↓'}</Button>
          </div>
        </div>
        {status && status.total === 0 && !status.syncing && <p className="muted">{t('catalog.empty')}</p>}
        {games.map((g) => (
          <div key={g.id} className="row-card" tabIndex={0} onMouseEnter={() => prefetch(g.id)} onFocus={() => prefetch(g.id)} onClick={() => go('game', String(g.id))} onKeyDown={(e) => e.key === 'Enter' && go('game', String(g.id))}>
            <Cover className="thumb" gameId={g.id} title={g.name}><Badge>{labelOf(g.console)}</Badge></Cover>
            <div>
              <div className="title">{g.name}</div>
              <div className="muted">{[g.developer, g.year].filter(Boolean).join(' · ')}</div>
              <div className="tags">{g.genre && <Tag>{genreLabel(g.genre, lang)}</Tag>}</div>
            </div>
          </div>
        ))}
        {page && page.total > games.length && <Button onClick={() => setCatalog({ limit: limit + PAGE })}>{t('catalog.more')}</Button>}
      </div>
      <aside className="filters">
        <FilterGroup title={t('filter.console')} count={CONSOLES.length} selected={consoles}
          groups={MAKERS.map((m) => ({ title: m, options: CONSOLES.filter((c) => c.maker === m).map((c) => c.id) }))}
          format={(id) => `${labelOf(id)} (${page?.consoles.find((c) => c.id === id)?.count ?? 0})`} onToggle={(o) => setCatalog({ consoles: toggle(consoles, o) })} />
        <FilterGroup title={t('filter.genre')} count={page?.genres.length ?? 0} options={(page?.genres ?? []).map((g) => g.name)} selected={genres}
          format={(n) => `${genreLabel(n, lang)} (${page?.genres.find((g) => g.name === n)?.count ?? 0})`} onToggle={(o) => setCatalog({ genres: toggle(genres, o) })} />
        <label className="check"><input type="checkbox" checked={variants} onChange={(e) => setCatalog({ variants: e.target.checked })} /> {t('catalog.variants')}</label>
      </aside>
    </div>
  )
}
