import { confirmDialog, alertDialog } from '@/ui/AskDialog'
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { create } from 'zustand'
import { t } from '@/i18n'
import { useApp } from '@/store/app'
import { useLibrary } from '@/store/library'
import { useEmulators } from '@/store/emulators'
import { useDialog } from '@/ui/CollectionDialogs'
import { playEntry } from '@/ui/PlayButton'
import { emulatorForConsole } from '@shared/emulators'
import type { LibraryEntry } from '@shared/library'

type MenuMode = 'quick' | 'full'

interface MenuState {
  at: { x: number; y: number; entryId: number; mode: MenuMode } | null
  show: (x: number, y: number, entryId: number, mode: MenuMode) => void
  hide: () => void
}
export const useEntryMenu = create<MenuState>((set) => ({
  at: null, show: (x, y, entryId, mode) => set({ at: { x, y, entryId, mode } }), hide: () => set({ at: null })
}))

/** Ouvre le menu rapide (jouer, favoris, collections, désinstaller…) d'un jeu au clic droit — tuiles et liste latérale. */
export const onEntryContext = (entryId: number) => (e: MouseEvent): void => {
  e.preventDefault(); e.stopPropagation()
  useEntryMenu.getState().show(e.clientX, e.clientY, entryId, 'quick')
}

/** Ouvre le menu complet (toutes les actions) sous le bouton ⚙ Options de la fiche du jeu. */
export const openEntryMenuAt = (e: MouseEvent<HTMLElement>, entryId: number): void => {
  const r = e.currentTarget.getBoundingClientRect()
  e.stopPropagation()
  useEntryMenu.getState().show(r.left, r.bottom + 4, entryId, 'full')
}

interface Action { key: string; label?: string; danger?: boolean; separator?: boolean; run?: () => Promise<void> | void }
const sep = (key: string): Action => ({ key, separator: true })

const favAction = (entry: LibraryEntry, lib: ReturnType<typeof useLibrary.getState>): Action =>
  ({ key: 'fav', label: `${entry.favorite ? '♥' : '♡'} ${t(entry.favorite ? 'fav.remove' : 'fav.add')}`, run: () => lib.setFlag(entry.id, { favorite: !entry.favorite }) })
const pinAction = (entry: LibraryEntry, lib: ReturnType<typeof useLibrary.getState>): Action =>
  ({ key: 'pin', label: `${entry.pinned ? '★' : '☆'} ${t(entry.pinned ? 'pin.remove' : 'pin.add')}`, run: () => lib.setFlag(entry.id, { pinned: !entry.pinned }) })
const editAction = (entry: LibraryEntry): Action =>
  ({ key: 'edit', label: `✎ ${t('edit.menu')}`, run: () => useDialog.getState().open({ kind: 'edit', entryId: entry.id }) })
const collectionAction = (entry: LibraryEntry): Action =>
  ({ key: 'collection', label: `▤ ${t('collection.addTo')}`, run: () => useDialog.getState().open({ kind: 'picker', entryId: entry.id }) })
/** Même action que `action.deleteFile` dans le menu complet, mais relabellée « Désinstaller » : une liste de
 * sources permet de retélécharger ce jeu, donc ce n'est pas un aller simple comme pour une ROM importée à la main. */
const uninstallAction = (entry: LibraryEntry, lib: ReturnType<typeof useLibrary.getState>): Action =>
  ({ key: 'uninstall', label: t('action.uninstall'), danger: true, run: async () => { if (await confirmDialog(t('confirm.uninstall', { title: entry.shownTitle }))) await lib.removeEntry(entry.id, 'file') } })

const deleteFileAction = (entry: LibraryEntry): Action =>
  ({ key: 'file', label: t('action.deleteFile'), danger: true, run: async () => { if (await confirmDialog(t('confirm.file', { title: entry.shownTitle }))) await useLibrary.getState().removeEntry(entry.id, 'file') } })
/** Retire la fiche de la bibliothèque (le jeu n'a plus de fichier : rien d'autre à supprimer). */
const removeEntryAction = (entry: LibraryEntry, lib: ReturnType<typeof useLibrary.getState>, back: () => void): Action =>
  ({ key: 'entry', label: t('action.removeEntry'), run: async () => { if (await confirmDialog(t('confirm.entry', { title: entry.shownTitle }))) { await lib.removeEntry(entry.id, 'entry'); leaveIfOpen(entry.id, back) } } })

/**
 * Menu rapide (clic droit sur une tuile ou dans la liste latérale) : seulement les actions les plus courantes, pas
 * les suppressions fines (ça reste dans le menu ⚙ Options complet de la fiche, pour ne pas supprimer quelque chose
 * par erreur depuis un simple clic droit).
 */
function quickActionsFor(entry: LibraryEntry): Action[] {
  const lib = useLibrary.getState()
  const hasFile = !entry.missing
  const def = emulatorForConsole(entry.console)
  const emulatorInstalled = useEmulators.getState().list.find((e) => e.id === def?.id)?.installed === true
  const running = useEmulators.getState().running.includes(entry.id)
  const list: Action[] = []
  if (hasFile && emulatorInstalled) {
    list.push(running
      ? { key: 'stop', label: `■ ${t('play.stop')}`, run: () => window.api.invoke('game:stop', entry.id) }
      : { key: 'play', label: `▶ ${t('play')}`, run: () => playEntry(entry) })
  } else if (!hasFile) {
    list.push({ key: 'link', label: t('action.link'), run: () => lib.link() })
  }
  if (list.length) list.push(sep('sep1'))
  list.push(favAction(entry, lib), pinAction(entry, lib), collectionAction(entry), editAction(entry))
  // Avec une source de téléchargement : « Désinstaller » (le jeu se retélécharge) ; sinon « Supprimer le fichier » (aller simple). Jamais les deux.
  if (hasFile) list.push(sep('sep2'), entry.hasSources ? uninstallAction(entry, lib) : deleteFileAction(entry))
  // Dans la bibliothèque mais pas installé (sans fichier) : on peut retirer la fiche.
  else list.push(sep('sep2'), removeEntryAction(entry, lib, useApp.getState().back))
  return list
}

/** Menu complet (bouton ⚙ Options de la fiche) : toutes les actions, groupées par nature et séparées par des barres. */
function fullActionsFor(entry: LibraryEntry, back: () => void): Action[] {
  const lib = useLibrary.getState()
  const hasFile = !entry.missing
  const ask = (key: string): Promise<boolean> => confirmDialog(t(`confirm.${key}`, { title: entry.shownTitle }))
  const list: Action[] = [favAction(entry, lib), pinAction(entry, lib), collectionAction(entry), editAction(entry), sep('sep1')]
  if (!hasFile) list.push({ key: 'link', label: t('action.link'), run: () => lib.link() })
  if (hasFile) {
    list.push({ key: 'reveal', label: t('action.reveal'), run: () => window.api.invoke('library:reveal', entry.id) })
    list.push(entry.hasSources ? uninstallAction(entry, lib) : deleteFileAction(entry))
  }
  list.push(sep('sep2'))
  list.push({ key: 'save', label: t('action.deleteSave'), danger: true, run: () => deleteSaves(entry, ask) })
  if (!hasFile) list.push(removeEntryAction(entry, lib, back))
  list.push({ key: 'all', label: t('action.deleteAll'), danger: true, run: async () => { if (await ask('all')) { await lib.removeEntry(entry.id, 'all'); leaveIfOpen(entry.id, back) } } })
  return list
}

/**
 * Supprime les sauvegardes du jeu. Propres au jeu (RetroArch, melonDS) : on supprime après confirmation. Mélangées avec celles des autres jeux
 * (tous les autres émulateurs) : rien n'est supprimé, on l'explique et on propose d'ouvrir le dossier.
 */
async function deleteSaves(entry: LibraryEntry, ask: (key: string) => Promise<boolean>): Promise<void> {
  const info = await window.api.invoke('saves:info', entry.id)
  if (info && info.scope === 'emulator') {
    if (await confirmDialog(t('action.saveShared', { name: emulatorForConsole(entry.console)?.name ?? info.emulator }))) await window.api.invoke('saves:open', entry.id)
    return
  }
  if (!info || info.files === 0) { await alertDialog(t('action.noSave')); return }
  if (await ask('save')) { await useLibrary.getState().removeEntry(entry.id, 'save'); await alertDialog(t('action.saveDeleted', { title: entry.shownTitle })) }
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
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
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
  // Reste dans la fenêtre quelle que soit sa taille réelle (nombre d'actions, échelle d'interface, longueur des
  // libellés traduits) : mesurée après rendu plutôt qu'estimée, sinon un menu déborde dès qu'il est un peu plus
  // grand que prévu (ex. clic droit tout en bas de la liste).
  useLayoutEffect(() => {
    if (!at || !ref.current) { setPos(null); return }
    const { offsetWidth: w, offsetHeight: h } = ref.current
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - h - 8)) })
  }, [at, entry])
  if (!at || !entry) return null
  const actions = at.mode === 'quick' ? quickActionsFor(entry) : fullActionsFor(entry, back)
  const { x, y } = pos ?? at
  return (
    <div ref={ref} className="ctx" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      <div className="ctx-title">{entry.shownTitle}</div>
      {actions.map((a) => (a.separator
        ? <div key={a.key} className="ctx-sep" />
        : <button key={a.key} className={a.danger ? 'danger' : ''} onClick={() => { hide(); void a.run?.() }}>{a.label}</button>))}
    </div>
  )
}
