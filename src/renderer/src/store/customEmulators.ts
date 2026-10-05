import { create } from 'zustand'
import { useEffect, useState } from 'react'
import type { CustomEmulatorState } from '@shared/customEmulators'
import type { LibraryEntry } from '@shared/library'
import type { IpcChannels } from '@shared/ipc'

interface CustomEmulatorsState {
  list: CustomEmulatorState[]
  loaded: boolean
  /** Incrémenté à chaque rechargement : les vues qui dépendent du choix d'émulateur (bouton Jouer) se rechargent. */
  rev: number
  refresh: () => Promise<void>
}

/** Émulateurs ajoutés par l'utilisateur (voir shared/customEmulators.ts). */
export const useCustomEmulators = create<CustomEmulatorsState>((set, get) => ({
  list: [], loaded: false, rev: 0,
  refresh: async () => { set({ list: await window.api.invoke('customEmulators:list'), loaded: true, rev: get().rev + 1 }) }
}))

export type EntryEmulators = IpcChannels['emulators:options']['res']

/**
 * Émulateurs qui savent lancer ce jeu et celui qui sera utilisé. Sans émulateur personnalisé, rien n'est demandé (null) : le comportement d'avant,
 * un seul émulateur par console, reste exactement le même. `rev` : rechargé quand le choix ou les émulateurs changent.
 */
export function useEntryEmulators(entry: LibraryEntry | undefined, rev = 0): EntryEmulators | null {
  const count = useCustomEmulators((s) => s.list.length)
  const customRev = useCustomEmulators((s) => s.rev)
  const [info, setInfo] = useState<EntryEmulators | null>(null)
  const active = count > 0 && entry !== undefined && entry.kind === 'rom'
  const id = entry?.id
  useEffect(() => {
    if (!active) { setInfo(null); return }
    let off = false
    void window.api.invoke('emulators:options', id!).then((i) => { if (!off) setInfo(i) })
    return () => { off = true }
  }, [active, id, entry?.emulatorId, customRev, rev])
  return info
}
