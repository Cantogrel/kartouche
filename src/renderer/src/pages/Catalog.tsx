import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FilterGroup, Tag, Badge, Cover, Button } from '@/ui'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { useSettings } from '@/store/settings'
import { useLibrary } from '@/store/library'
import { useDownloads } from '@/store/downloads'
import { CONSOLES, MAKERS, consoleById } from '@shared/consoles'
import { genreLabel } from '@shared/genres'
import { PUBLISHER_OTHER, publisherLabel } from '@shared/publishers'
import { SOURCE_FILTER_ANY, type CatalogPage, type CatalogSort, type SyncProgress } from '@shared/catalog'

const PAGE = 60
const SOURCE_TAGS_SHOWN = 3
const toggle = (arr: string[], v: string): string[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
const labelOf = (id: string): string => consoleById(id)?.label ?? id
const DEFAULT_DIR = { popularity: 'desc', year: 'desc', title: 'asc', random: 'asc' } as const
const newSeed = (): number => Math.floor(Math.random() * 1_000_000)
// Position de scroll de la liste, conservée hors de l'état React pour survivre au démontage de la page (fiche jeu puis retour).
let lastScrollTop = 0

export function Catalog({ query }: { query: string }) {
  const { go, catalog: view, setCatalog } = useApp()
  const { consoles, genres, publishers, sources, sort, dir, seed, variants, limit } = view
  const lang = useSettings((s) => s.lang)
  const effectiveDir = dir ?? DEFAULT_DIR[sort]
  const [page, setPage] = useState<CatalogPage | null>(null)
  const [status, setStatus] = useState<{ total: number; syncing: boolean; enriched: boolean } | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  // Jeux déjà à la bibliothèque (gameId → fichier présent ou non) et téléchargements en cours (gameId → % ou null), pour l'indicateur des cartes.
  const entries = useLibrary((s) => s.entries)
  const jobs = useDownloads((s) => s.jobs)
  useEffect(() => { void useLibrary.getState().refresh() }, [])
  const owned = new Map<number, boolean>()
  for (const e of entries) if (e.gameId !== null) owned.set(e.gameId, (owned.get(e.gameId) ?? false) || !e.missing)
  const downloading = new Map<number, number | null>()
  for (const j of Object.values(jobs)) if (j.gameId !== undefined) downloading.set(j.gameId, j.total > 0 ? Math.round((j.done / j.total) * 100) : null)
  const reqId = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRestored = useRef(false)
  // Remonte à la position de scroll précédente une fois la liste chargée (retour depuis la fiche d'un jeu).
  useLayoutEffect(() => {
    if (scrollRestored.current || !page || !contentRef.current) return
    scrollRestored.current = true
    contentRef.current.scrollTop = lastScrollTop
  }, [page])
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
      window.api.invoke('catalog:search', { q: query, consoles, genres, publishers, sources, sort, dir: effectiveDir, seed, limit, includeVariants: variants })
        .then((p) => { if (id === reqId.current) setPage(p) })
    }, 150)
    return () => clearTimeout(h)
  }, [query, consoles, genres, publishers, sources, sort, effectiveDir, seed, limit, variants, status?.total, status?.enriched])

  // Tout changement de filtre ou de recherche (après le premier rendu) revient à la première page.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setCatalog({ limit: PAGE })
  }, [query, consoles, genres, publishers, sources, sort, effectiveDir, seed, variants, setCatalog])

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

  // SOURCE_FILTER_ANY est exclusif des listes précises (l'un décoche l'autre) ; plusieurs listes précises restent cumulables entre elles.
  const toggleSource = (id: string): void => setCatalog({
    sources: id === SOURCE_FILTER_ANY
      ? (sources.includes(SOURCE_FILTER_ANY) ? [] : [SOURCE_FILTER_ANY])
      : toggle(sources.filter((s) => s !== SOURCE_FILTER_ANY), id)
  })

  const games = page?.games ?? []
  return (
    <div className="content catalog" ref={contentRef} onScroll={(e) => { lastScrollTop = e.currentTarget.scrollTop }}>
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
              <select value={sort} onChange={(e) => setCatalog({ sort: e.target.value as CatalogSort, dir: null, seed: newSeed() })}>
                <option value="popularity">{t('sort.popularity')}</option>
                <option value="title">{t('sort.title')}</option>
                <option value="year">{t('sort.year')}</option>
                <option value="random">{t('sort.random')}</option>
              </select>
            </label>
            {sort === 'random'
              // Aléatoire : pas de sens de tri, la flèche circulaire relance le tirage.
              ? <Button className="sortdir" aria-label={t('sort.reroll')} title={t('sort.reroll')} onClick={() => setCatalog({ seed: newSeed() })}>↻</Button>
              // ↓ = ordre naturel du critère (plus populaires/récents d'abord, A→Z), ↑ = inversé.
              : <Button className="sortdir" aria-label={t(effectiveDir === 'asc' ? 'sort.asc' : 'sort.desc')} title={t(effectiveDir === 'asc' ? 'sort.asc' : 'sort.desc')}
                  onClick={() => setCatalog({ dir: effectiveDir === 'asc' ? 'desc' : 'asc' })}>{effectiveDir === DEFAULT_DIR[sort] ? '↓' : '↑'}</Button>}
          </div>
        </div>
        {status && status.total === 0 && !status.syncing && <p className="muted">{t('catalog.empty')}</p>}
        {page === null && Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="row-card skeleton-item">
            <div className="thumb skeleton-block" />
            <div>
              <span className="skeleton" style={{ width: '55%' }} />
              <span className="skeleton" style={{ width: '35%' }} />
              <span className="skeleton" style={{ width: '20%' }} />
            </div>
          </div>
        ))}
        {games.map((g) => (
          <div key={g.id} className="row-card" role="button" tabIndex={0} onMouseEnter={() => prefetch(g.id)} onFocus={() => prefetch(g.id)} onClick={() => go('game', String(g.id))} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('game', String(g.id)) } }}>
            <Cover className="thumb" gameId={g.id} title={g.name}><Badge>{labelOf(g.console)}</Badge></Cover>
            <div>
              <div className="title">{g.name}</div>
              <div className="muted">{[g.developer, g.year].filter(Boolean).join(' · ')}</div>
              <div className="tags">{g.genre && <Tag>{genreLabel(g.genre, lang)}</Tag>}</div>
              {((g.sourceLists?.length ?? 0) > 0 || owned.has(g.id) || downloading.has(g.id)) && (
                <div className="tags source-tags">
                  {downloading.has(g.id)
                    ? <Tag className="tag-state tag-busy">⬇ {t('catalog.downloading')}{downloading.get(g.id) !== null ? ` ${downloading.get(g.id)} %` : ''}</Tag>
                    : owned.has(g.id) && (owned.get(g.id) ? <Tag className="tag-state tag-ok">✓ {t('catalog.installed')}</Tag> : <Tag className="tag-state">{t('catalog.inLibrary')}</Tag>)}
                  {(g.sourceLists ?? []).slice(0, SOURCE_TAGS_SHOWN).map((name) => <Tag key={name} title={t('catalog.sourceTagTitle', { name })}>⬇ {name}</Tag>)}
                  {(g.sourceLists?.length ?? 0) > SOURCE_TAGS_SHOWN && <Tag>+{g.sourceLists!.length - SOURCE_TAGS_SHOWN}</Tag>}
                </div>
              )}
            </div>
          </div>
        ))}
        {page && page.total > games.length && <Button onClick={() => setCatalog({ limit: limit + PAGE })}>{t('catalog.more')}</Button>}
      </div>
      <aside className="filters">
        <FilterGroup title={t('filter.console')} count={CONSOLES.length} selected={consoles}
          groups={MAKERS.map((m) => ({ title: m, options: CONSOLES.filter((c) => c.maker === m).map((c) => c.id) }))}
          format={(id) => `${labelOf(id)} (${page?.consoles.find((c) => c.id === id)?.count ?? 0})`} onToggle={(o) => setCatalog({ consoles: toggle(consoles, o) })} />
        <FilterGroup title={t('filter.publisher')} count={page?.publishers.length ?? 0} options={(page?.publishers ?? []).map((p) => p.id)} selected={publishers}
          format={(id) => `${id === PUBLISHER_OTHER ? t('filter.publisherOther') : publisherLabel(id)} (${page?.publishers.find((p) => p.id === id)?.count ?? 0})`}
          onToggle={(o) => setCatalog({ publishers: toggle(publishers, o) })} />
        {(page?.sources.length ?? 0) > 0 && (
          <FilterGroup title={t('filter.source')} count={page!.sources.length} options={page!.sources.map((s) => s.id)} selected={sources}
            format={(id) => { const s = page!.sources.find((x) => x.id === id)!; return `${id === SOURCE_FILTER_ANY ? t('filter.sourceAny') : s.name} (${s.count})` }}
            onToggle={toggleSource} />
        )}
        <FilterGroup title={t('filter.genre')} count={page?.genres.length ?? 0} options={(page?.genres ?? []).map((g) => g.name)} selected={genres}
          format={(n) => `${genreLabel(n, lang)} (${page?.genres.find((g) => g.name === n)?.count ?? 0})`} onToggle={(o) => setCatalog({ genres: toggle(genres, o) })} />
        <label className="check filter-variants"><input type="checkbox" checked={variants} onChange={(e) => setCatalog({ variants: e.target.checked })} /> {t('catalog.variants')}</label>
      </aside>
    </div>
  )
}
