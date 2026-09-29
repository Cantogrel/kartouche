import { t } from '@/i18n'
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

/** Dégradé déterministe servant de jaquette tant qu'aucune image n'est disponible. */
export function artStyle(seed: string): { background: string } {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360
  return { background: `linear-gradient(160deg, hsl(${h} 45% 28%), hsl(${(h + 50) % 360} 50% 12%))` }
}

export const Badge = ({ children, side = 'l' }: { children: ReactNode; side?: 'l' | 'r' }) => (
  <span className={`badge ${side}`}>{children}</span>
)
export const Tag = ({ children }: { children: ReactNode }) => <span className="tag">{children}</span>

export const ProgressBar = ({ value }: { value: number }) => (
  <div className="progress"><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
)

export const Button = ({ variant = 'default', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'icon' }) => (
  <button className={`btn ${variant} ${className}`} {...p} />
)

export const Pill = ({ active, children, onClick }: { active?: boolean; children: ReactNode; onClick?: () => void }) => (
  <button className={`pill${active ? ' active' : ''}`} aria-pressed={active} onClick={onClick}>{children}</button>
)

export const PageHead = ({ title, onBack, children }: { title: string; onBack?: () => void; children?: ReactNode }) => (
  <div className="pagehead">
    <div className="pagehead-l">
      {onBack && <button className="back" onClick={onBack} aria-label={t('back')} title={t('back')}>←</button>}
      <h1>{title}</h1>
    </div>
    <div className="pagehead-r">{children}</div>
  </div>
)

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="section"><h2>{title}</h2>{children}</section>
)

export function FilterGroup({ title, count, options, groups, selected, onToggle, format }: {
  title: string; count?: number; selected: string[]; onToggle: (o: string) => void; format?: (o: string) => string
  /** Liste plate… */ options?: string[]
  /** …ou sous-catégories (ex. consoles par constructeur). */ groups?: { title: string; options: string[] }[]
}) {
  const box = (o: string) => (
    <label key={o} className="check">
      <input type="checkbox" checked={selected.includes(o)} onChange={() => onToggle(o)} /> {format ? format(o) : o}
    </label>
  )
  return (
    <div className="fgroup">
      <h3>{title} {count !== undefined && <span className="count">{count}</span>}</h3>
      {options?.map(box)}
      {groups?.map((g) => (
        <div key={g.title} className="fsub">
          <h4>{g.title}</h4>
          {g.options.map(box)}
        </div>
      ))}
    </div>
  )
}

export const GameCard = ({ title, console: cons, hasFile, progress, minutes, onClick }: {
  title: string; console: string; hasFile: boolean; progress?: number; minutes?: number; onClick?: () => void
}) => (
  <div className={`card${hasFile ? '' : ' nofile'}`} role="button" tabIndex={0} aria-label={`${title} (${cons})`} style={artStyle(title)} onClick={onClick}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.() } }}>
    <div className="art">{title}</div>
    <Badge side="l">{cons}</Badge>
    {hasFile && <Badge side="r">✓</Badge>}
    {progress !== undefined && <ProgressBar value={progress} />}
    {minutes !== undefined && hasFile && <span className="mins">{minutes} min</span>}
  </div>
)

/**
 * Illustration d'un jeu du catalogue, résolue et mise en cache par le processus principal (rvimg://).
 * Format horizontal : l'image remplit le cadre ; une jaquette verticale est affichée entière sur fond flouté.
 * Sans image, le dégradé déterministe reste visible.
 */
export function Cover({ gameId, title, kind = 'card', className, children }: { gameId: number; title: string; kind?: 'card' | 'tile' | 'hero'; className?: string; children?: ReactNode }) {
  const src = `rvimg://${kind}/${gameId}`
  // L'état est rattaché à l'URL : quand la liste est refiltrée et que le composant est réutilisé pour un autre jeu, on repart de « chargement »
  // sans effet différé (un effet remettait « chargement » APRÈS l'événement load d'une image en cache, et l'image restait invisible).
  const [res, setRes] = useState<{ src: string; v: 'wide' | 'tall' | 'none' } | null>(null)
  const state = res && res.src === src ? res.v : 'loading'
  const settle = (img: HTMLImageElement | null): void => {
    if (img && img.complete && img.naturalWidth > 0 && !(res && res.src === src)) setRes({ src, v: img.naturalHeight > img.naturalWidth ? 'tall' : 'wide' })
  }
  return (
    <div className={className} style={artStyle(title)}>
      {state === 'tall' && <img className="cover-img blur" alt="" src={src} />}
      {state !== 'none' && (
        <img key={src} ref={settle} className={`cover-img${state === 'tall' ? ' tall' : ''}`} style={{ opacity: state === 'loading' ? 0 : undefined }} loading="lazy" alt="" src={src}
          onLoad={(e) => setRes({ src, v: e.currentTarget.naturalHeight > e.currentTarget.naturalWidth ? 'tall' : 'wide' })} onError={() => setRes({ src, v: 'none' })} />
      )}
      {children}
    </div>
  )
}

/** Champ de recherche avec une croix pour l'effacer. */
export function SearchBox({ value, onChange, placeholder, className = '', clearLabel }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string; clearLabel: string }) {
  return (
    <span className={`searchbox ${className}`}>
      <input className="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onChange('')} />
      {value && <button className="clear" aria-label={clearLabel} title={clearLabel} onClick={() => onChange('')}>✕</button>}
    </span>
  )
}
