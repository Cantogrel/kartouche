import type { ReactNode } from 'react'

export const Badge = ({ children, side = 'l' }: { children: ReactNode; side?: 'l' | 'r' }) => (
  <span className={`badge ${side}`}>{children}</span>
)
export const ProgressBar = ({ value }: { value: number }) => (
  <div className="progress"><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
)
export const GameCard = ({ title, console: cons, hasFile, progress }: { title: string; console: string; hasFile: boolean; progress?: number }) => (
  <div className={`card${hasFile ? '' : ' nofile'}`} tabIndex={0}>
    <div className="art">{title}</div>
    <Badge side="l">{cons}</Badge>
    {progress !== undefined && <ProgressBar value={progress} />}
  </div>
)
