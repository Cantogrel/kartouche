import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

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
  <button className={`pill${active ? ' active' : ''}`} onClick={onClick}>{children}</button>
)

export const PageHead = ({ title, onBack, children }: { title: string; onBack?: () => void; children?: ReactNode }) => (
  <div className="pagehead">
    <div className="pagehead-l">
      {onBack && <button className="back" onClick={onBack} aria-label="back">←</button>}
      <h1>{title}</h1>
    </div>
    <div className="pagehead-r">{children}</div>
  </div>
)

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="section"><h2>{title}</h2>{children}</section>
)

export function FilterGroup({ title, count, options, selected, onToggle, format }: {
  title: string; count?: number; options: string[]; selected: string[]; onToggle: (o: string) => void; format?: (o: string) => string
}) {
  return (
    <div className="fgroup">
      <h3>{title} {count !== undefined && <span className="count">{count}</span>}</h3>
      {options.map((o) => (
        <label key={o} className="check">
          <input type="checkbox" checked={selected.includes(o)} onChange={() => onToggle(o)} /> {format ? format(o) : o}
        </label>
      ))}
    </div>
  )
}

export const GameCard = ({ title, console: cons, hasFile, progress, minutes, onClick }: {
  title: string; console: string; hasFile: boolean; progress?: number; minutes?: number; onClick?: () => void
}) => (
  <div className={`card${hasFile ? '' : ' nofile'}`} tabIndex={0} style={artStyle(title)} onClick={onClick}
    onKeyDown={(e) => e.key === 'Enter' && onClick?.()}>
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
export function Cover({ gameId, title, kind = 'card', className, children }: { gameId: number; title: string; kind?: 'card' | 'hero'; className?: string; children?: ReactNode }) {
  const [state, setState] = useState<'loading' | 'wide' | 'tall' | 'none'>('loading')
  useEffect(() => setState('loading'), [gameId, kind])
  const src = `rvimg://${kind}/${gameId}`
  return (
    <div className={className} style={artStyle(title)}>
      {state === 'tall' && <img className="cover-img blur" alt="" src={src} />}
      {state !== 'none' && (
        <img className={`cover-img${state === 'tall' ? ' tall' : ''}`} style={{ opacity: state === 'loading' ? 0 : undefined }} loading="lazy" alt="" src={src}
          onLoad={(e) => setState(e.currentTarget.naturalHeight > e.currentTarget.naturalWidth ? 'tall' : 'wide')} onError={() => setState('none')} />
      )}
      {children}
    </div>
  )
}
