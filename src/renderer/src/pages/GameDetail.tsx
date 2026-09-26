import { Button } from '@/ui'
import { t } from '@/i18n'
import { CatalogGameDetail, LibraryFile } from './CatalogGame'
import { useLibrary } from '@/store/library'
import { openEntryMenuAt } from '@/ui/EntryMenu'
import { useApp } from '@/store/app'
import { PlayButton } from '@/ui/PlayButton'
import { AchievementsPanel, FlagButtons, SavesPanel } from '@/ui/GameExtras'
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
  useEffect(() => { if (entry) setPageTitle(entry.title) }, [entry, setPageTitle])
  if (!entry) return null
  if (entry.gameId !== null) return <CatalogGameDetail id={entry.gameId} entry={entry} />
  return <div className="content"><div className="panel"><h3>{entry.title}</h3><p className="muted">{t('match.none')}</p><LibraryFile entry={entry} /><div className="row" style={{ marginTop: 12 }}>{entry.missing ? <Button variant="primary" onClick={() => void useLibrary.getState().link()}>{t('linkRom')}</Button> : <PlayButton entry={entry} />}<FlagButtons entry={entry} /><Button onClick={(e) => openEntryMenuAt(e, entry.id)}>⚙ {t('options')}</Button></div></div>{!entry.missing && <SavesPanel entry={entry} />}{!entry.missing && <AchievementsPanel entry={entry} />}</div>
}
