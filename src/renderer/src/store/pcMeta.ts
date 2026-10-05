import { useEffect, useState } from 'react'
import { useLibrary } from '@/store/library'
import type { LibraryEntry } from '@shared/library'
import type { PcMetaView } from '@shared/pcMeta'

/** Fiche IGDB d'un jeu PC (exécutable, jeu de launcher) ; null pour une ROM, un jeu pas encore reconnu ou sans entrée. Se recharge quand la bibliothèque l'est. */
export function usePcMeta(entry: LibraryEntry | undefined): PcMetaView | null {
  const [meta, setMeta] = useState<PcMetaView | null>(null)
  const rev = useLibrary((s) => s.rev)
  const id = entry && entry.kind !== 'rom' ? entry.id : undefined
  useEffect(() => {
    if (id === undefined) { setMeta(null); return }
    let off = false
    void window.api.invoke('library:pcMeta', id).then((m) => { if (!off) setMeta(m) }).catch(() => undefined)
    return () => { off = true }
  }, [id, rev])
  return meta
}
