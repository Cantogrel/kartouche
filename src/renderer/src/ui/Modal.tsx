import { useEffect, useRef, type ReactNode } from 'react'

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const box = useRef<HTMLDivElement>(null)
  // Le focus entre dans la fenetre (premier champ, sinon la fenetre elle-meme) et revient au declencheur a la fermeture.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ;(box.current?.querySelector<HTMLElement>('input, button') ?? box.current)?.focus()
    return () => before?.focus?.()
  }, [])
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}
