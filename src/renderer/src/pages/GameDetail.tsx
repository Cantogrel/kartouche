import { Button, Cover, Tag } from '@/ui'
import { t, getLang } from '@/i18n'
import { genreLabel } from '@shared/genres'
import { CatalogGameDetail, LibraryFile } from './CatalogGame'
import { useLibrary } from '@/store/library'
import { useEntryOverrides } from '@/store/overrides'
import { useDialog } from '@/ui/CollectionDialogs'
import { openEntryMenuAt } from '@/ui/EntryMenu'
import { useApp } from '@/store/app'
import { OpenEmulatorButton, PlayButton, QuickExitNotice } from '@/ui/PlayButton'
import { PlayWithButton } from '@/ui/PlayWith'
import { AchievementsPanel, ContentPanel, FlagButtons, SavesPanel } from '@/ui/GameExtras'
import { useEffect } from 'react'
import { MediaSections } from '@/ui/GameMedia'
import { usePcMeta } from '@/store/pcMeta'
import { defaultBackgroundId, igdbImageUrl } from '@shared/media'
import { baseViewFrom, resolveView, splitGenres, type EntryOverrides } from '@shared/overrides'
import type { LibraryEntry } from '@shared/library'

/** `lib:<id>` = jeu de la bibliothèque, un nombre = jeu du catalogue. */
export function GameDetail({ gameId }: { gameId?: string }) {
  if (gameId?.startsWith('lib:')) return <LibraryGameDetail entryId={Number(gameId.slice(4))} />
  if (gameId && /^[0-9]+$/.test(gameId)) return <CatalogGameDetail id={Number(gameId)} />
  return null
}

/** Jeu de la bibliothèque : fiche du catalogue si le jeu est reconnu, sinon simple fiche de fichier. */
function LibraryGameDetail({ entryId }: { entryId: number }) {
  const { entries, loaded, refresh } = useLibrary()
  const setPageTitle = useApp((s) => s.setPageTitle)
  const entry = entries.find((e) => e.id === entryId)
  useEffect(() => { if (!loaded) void refresh() }, [loaded, refresh])
  useEffect(() => { if (entry) setPageTitle(entry.shownTitle) }, [entry, setPageTitle])
  const ov = useEntryOverrides(entry)
  if (!entry) return null
  if (entry.gameId !== null) return <CatalogGameDetail id={entry.gameId} entry={entry} />
  return <FileGameDetail entry={entry} ov={ov} />
}

/** Jeu sans fiche de catalogue : ROM non reconnue, exécutable ajouté ou jeu d'un launcher (fiche IGDB quand elle est trouvée). */
function FileGameDetail({ entry, ov }: { entry: LibraryEntry; ov: EntryOverrides }) {
  const pc = usePcMeta(entry)
  const view = resolveView(baseViewFrom(null, pc?.details ?? null, entry.title), ov)
  const defaultBg = defaultBackgroundId(pc?.media, true)
  const backdropUrl = entry.art.background ? `kimg://custom/${entry.art.background}` : defaultBg ? igdbImageUrl(defaultBg, 't_1080p') : null
  return <div className="content nopad detail-page">{backdropUrl && <div className="detail-backdrop" aria-hidden style={{ backgroundImage: `url(${backdropUrl})` }} />}{entry.art.banner && <Cover className="hero hero-short" kind="hero" gameId={null} art={entry.art.banner} title={entry.shownTitle}><div className="hero-title">{entry.shownTitle}</div></Cover>}<div className="detail">{!entry.missing && <QuickExitNotice entryId={entry.id} />}<div className="panel">{!entry.art.banner && <h3>{entry.shownTitle}</h3>}{(view.year || view.developer || view.genre) && <div className="muted">{[view.year, view.developer].filter(Boolean).join(' · ')}{splitGenres(view.genre).map((g) => <Tag key={g}>{genreLabel(g, getLang())}</Tag>)}</div>}{view.description && <p>{view.description}</p>}{entry.kind === 'rom' ? <><p className="muted">{t('match.none')}</p><LibraryFile entry={entry} /></> : <><p className="muted">{entry.source && entry.source !== 'manual' ? t('launcher.from', { source: entry.source }) : t('exe.local')}</p><p className="muted" title={entry.path}>{entry.path}</p></>}<div className="row" style={{ marginTop: 12 }}>{entry.missing ? <Button variant="primary" onClick={() => void useLibrary.getState().link()}>{t('linkRom')}</Button> : <><PlayButton entry={entry} /><PlayWithButton entry={entry} /><OpenEmulatorButton entry={entry} /></>}<FlagButtons entry={entry} /><Button onClick={() => useDialog.getState().open({ kind: 'edit', entryId: entry.id })}>{t('edit.button')}</Button><Button onClick={(e) => openEntryMenuAt(e, entry.id)}>⚙ {t('options')}</Button></div></div>{entry.kind !== 'rom' && <MediaSections media={pc?.media ?? null} />}{entry.kind === 'rom' && <>{!entry.missing && <SavesPanel entry={entry} />}<ContentPanel entry={entry} />{!entry.missing && <AchievementsPanel entry={entry} />}</>}</div></div>
}
