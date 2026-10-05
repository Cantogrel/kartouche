import { useState, type ReactNode } from 'react'
import { t } from '@/i18n'

const KEY = (id: string): string => `kartouche.section.${id}`
const read = (id: string, fallback: boolean): boolean => { try { const v = localStorage.getItem(KEY(id)); return v === null ? fallback : v === '1' } catch { return fallback } }
const write = (id: string, open: boolean): void => { try { localStorage.setItem(KEY(id), open ? '1' : '0') } catch { /* stockage indisponible : l'état n'est simplement pas retenu */ } }

/** Panneau de la fiche dont on peut replier le contenu ; l'état (ouvert/replié) est retenu par section, pour tous les jeux. */
export function Section({ id, title, children, defaultOpen = true, className = '' }: { id: string; title: string; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(() => read(id, defaultOpen))
  const toggle = (): void => { setOpen((o) => { write(id, !o); return !o }) }
  return (
    <section className={`panel section${open ? '' : ' closed'} ${className}`.trim()}>
      <h3 className="section-head">
        <button type="button" className="section-toggle" aria-expanded={open} onClick={toggle} title={t(open ? 'section.collapse' : 'section.expand')}>
          <span className="section-chevron" aria-hidden>{open ? '▾' : '▸'}</span>{title}
        </button>
      </h3>
      {open && <div className="section-body">{children}</div>}
    </section>
  )
}
