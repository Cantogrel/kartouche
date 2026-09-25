import { useEffect, type MouseEvent } from 'react'
import { create } from 'zustand'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import type { LibraryEntry } from '@shared/library'

interface MenuState {
  at: { x: number; y: number; entryId: number } | null
  show: (x: number, y: number, entryId: number) => void
  hide: () => void
}
export const useEntryMenu = create<MenuState>((set) => ({ at: null, show: (x, y, entryId) => set({ at: { x, y, entryId } }), hide: () => set({ at: null }) }))

/** Ouvre le menu des actions d'un jeu de la bibliothèque au clic droit. */
export const onEntryContext = (entryId: number) => (e: MouseEvent): void => {
  e.preventDefault(); e.stopPropagation()
  useEntryMenu.getState().show(e.clientX, e.clientY, entryId)
}

/** Ouvre le même menu sous un bouton (fiche du jeu). */
export const openEntryMenuAt = (e: MouseEvent<HTMLElement>, entryId: number): void => {
  const r = e.currentTarget.getBoundingClientRect()
  e.stopPropagation()
  useEntryMenu.getState().show(r.left, r.bottom + 4, entryId)
}

interface Action { key: string; label: string; danger?: boolean; run: () => Promise<void> | void }

function actionsFor(entry: LibraryEntry, back: () => void): Action[] {
  const lib = useLibrary.getState()
  const hasFile = !entry.missing
  const ask = (key: string): boolean => window.confirm(t(`confirm.${key}`, { title: entry.title }))
  const list: Action[] = []
  if (!hasFile) list.push({ key: 'link', label: t('action.link'), run: () => lib.link() })
  if (hasFile) list.push({ key: 'reveal', label: t('action.reveal'), run: () => window.api.invoke('library:reveal', entry.id) })
  if (hasFile) list.push({ key: 'file', label: t('action.deleteFile'), danger: true, run: async () => { if (ask('file')) await lib.removeEntry(entry.id, 'file') } })
  list.push({ key: 'save', label: t('action.deleteSave'), danger: true, run: async () => { if (ask('save')) await lib.removeEntry(entry.id, 'save') } })
  list.push({ key: 'entry', label: t('action.removeEntry'), run: async () => { if (ask('entry')) { await lib.removeEntry(entry.id, 'entry'); leaveIfOpen(entry.id, back) } } })
  list.push({ key: 'all', label: t('action.deleteAll'), danger: true, run: async () => { if (ask('all')) { await lib.removeEntry(entry.id, 'all'); leaveIfOpen(entry.id, back) } } })
  return list
}

/** Si la fiche du jeu retiré est affichée, on revient à la page précédente. */
function leaveIfOpen(entryId: number, back: () => void): void {
  const { route, gameId } = useApp.getState()
  if (route === 'game' && gameId === `lib:${entryId}`) back()
}

/** Menu contextuel unique de l'application (rendu une fois, dans App). */
export function EntryMenu() {
  const { at, hide } = useEntryMenu()
  const entry = useLibrary((s) => s.entries.find((e) => e.id === at?.entryId))
  const back = useApp((s) => s.back)
  useEffect(() => {
    if (!at) return
    const close = (): void => hide()
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') hide() }
    window.addEventListener('click', close); window.addEventListener('blur', close); window.addEventListener('resize', close)
    window.addEventListener('contextmenu', close, true); window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('click', close); window.removeEventListener('blur', close); window.removeEventListener('resize', close)
      window.removeEventListener('contextmenu', close, true); window.removeEventListener('keydown', key)
    }
  }, [at, hide])
  if (!at || !entry) return null
  const actions = actionsFor(entry, back)
  // Reste dans la fenêtre : on remonte le menu s'il déborde en bas ou à droite.
  const x = Math.min(at.x, window.innerWidth - 250), y = Math.min(at.y, window.innerHeight - actions.length * 38 - 16)
  return (
    <div className="ctx" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      <div className="ctx-title">{entry.title}</div>
      {actions.map((a) => (
        <button key={a.key} className={a.danger ? 'danger' : ''} onClick={() => { hide(); void a.run() }}>{a.label}</button>
      ))}
    </div>
  )
}
