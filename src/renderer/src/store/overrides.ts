import { useEffect, useState } from 'react'
import { useLibrary } from '@/store/library'
import type { LibraryEntry } from '@shared/library'
import type { EntryOverrides } from '@shared/overrides'

/** Valeurs modifiées par l'utilisateur sur un jeu de la bibliothèque ; se recharge quand la liste est rechargée (après une modification). Vide sans entrée. */
export function useEntryOverrides(entry: LibraryEntry | undefined): EntryOverrides {
  const [ov, setOv] = useState<EntryOverrides>({})
  const rev = useLibrary((s) => s.rev)
  const id = entry?.id
  useEffect(() => {
    if (id === undefined) { setOv({}); return }
    let off = false
    void window.api.invoke('library:overrides', id).then((o) => { if (!off) setOv(o) })
    return () => { off = true }
  }, [id, rev])
  return ov
}
