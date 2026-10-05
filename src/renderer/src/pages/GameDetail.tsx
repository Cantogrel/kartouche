import { Button, Cover, Tag } from '@/ui'
import { t } from '@/i18n'
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
  return <div className="content">{!entry.missing && <QuickExitNotice entryId={entry.id} />}<div className="panel">{entry.art.banner && <Cover className="edit-banner" kind="hero" gameId={null} art={entry.art.banner} title={entry.shownTitle} />}<h3>{entry.shownTitle}</h3>{(ov.year || ov.developer || ov.genre) && <div className="muted">{[ov.year, ov.developer].filter(Boolean).join(' · ')}{ov.genre && <Tag>{ov.genre}</Tag>}</div>}{ov.description && <p>{ov.description}</p>}<p className="muted">{t('match.none')}</p><LibraryFile entry={entry} /><div className="row" style={{ marginTop: 12 }}>{entry.missing ? <Button variant="primary" onClick={() => void useLibrary.getState().link()}>{t('linkRom')}</Button> : <><PlayButton entry={entry} /><PlayWithButton entry={entry} /><OpenEmulatorButton entry={entry} /></>}<FlagButtons entry={entry} /><Button onClick={() => useDialog.getState().open({ kind: 'edit', entryId: entry.id })}>{t('edit.button')}</Button><Button onClick={(e) => openEntryMenuAt(e, entry.id)}>⚙ {t('options')}</Button></div></div>{!entry.missing && <SavesPanel entry={entry} />}<ContentPanel entry={entry} />{!entry.missing && <AchievementsPanel entry={entry} />}</div>
}
