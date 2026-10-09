import type { PadKind } from '@shared/pads'

// Silhouettes simples des manettes (traits au `currentColor`, rien de propre à une marque) : sert aux listes de manettes des Paramètres et du Big Picture.
const BODY: Record<'xinput' | 'switch-pro' | 'other', string> = {
  xinput: 'M22 14h52c9 0 14 6 17 18l3 12c1 5-1 9-6 9-4 0-7-3-10-7l-4-5H22l-4 5c-3 4-6 7-10 7-5 0-7-4-6-9l3-12c3-12 8-18 17-18z',
  'switch-pro': 'M26 12h44c10 0 16 5 19 17l4 16c1 6-2 10-7 10-5 0-8-3-11-8l-3-5H24l-3 5c-3 5-6 8-11 8-5 0-8-4-7-10l4-16c3-12 9-17 19-17z',
  other: 'M22 14h52c9 0 14 6 17 18l3 12c1 5-1 9-6 9-4 0-7-3-10-7l-4-5H22l-4 5c-3 4-6 7-10 7-5 0-7-4-6-9l3-12c3-12 8-18 17-18z'
}

function joycon(x: number, side: 'left' | 'right') {
  return (
    <g transform={`translate(${x} 0)`}>
      <rect x="0" y="4" width="22" height="48" rx="10" />
      {side === 'left' ? (
        <>
          <circle cx="11" cy="16" r="4.5" />
          <circle cx="11" cy="31" r="1.6" /><circle cx="11" cy="40" r="1.6" /><circle cx="6.5" cy="35.5" r="1.6" /><circle cx="15.5" cy="35.5" r="1.6" />
        </>
      ) : (
        <>
          <circle cx="11" cy="22" r="1.6" /><circle cx="11" cy="31" r="1.6" /><circle cx="6.5" cy="26.5" r="1.6" /><circle cx="15.5" cy="26.5" r="1.6" />
          <circle cx="11" cy="40" r="4.5" />
        </>
      )}
    </g>
  )
}

/** Silhouette de la manette `kind`. Décorative : le titre de la ligne dit déjà de quoi il s'agit. */
export function PadIcon({ kind, size = 56, apart = false }: { kind: PadKind; size?: number; apart?: boolean }) {
  const narrow = kind === 'joycon-left' || kind === 'joycon-right'
  const common = {
    width: size * (narrow ? 0.4 : kind === 'joycon-pair' ? (apart ? 1.4 : 1) : 1.7), height: size, 'aria-hidden': true, className: 'pad-icon',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const
  }
  if (kind === 'joycon-left') return <svg {...common} viewBox="0 0 22 56">{joycon(0, 'left')}</svg>
  if (kind === 'joycon-right') return <svg {...common} viewBox="0 0 22 56">{joycon(0, 'right')}</svg>
  if (kind === 'joycon-pair') return apart ? <svg {...common} viewBox="0 0 78 56">{joycon(0, 'left')}{joycon(56, 'right')}</svg> : <svg {...common} viewBox="0 0 56 56">{joycon(0, 'left')}{joycon(34, 'right')}</svg>
  return (
    <svg {...common} viewBox="0 0 96 56">
      <path d={BODY[kind]} />
      <circle cx="30" cy="25" r="5" /><circle cx="60" cy="35" r="5" />
      <circle cx="72" cy="23" r="1.8" /><circle cx="78" cy="29" r="1.8" /><circle cx="66" cy="29" r="1.8" /><circle cx="72" cy="35" r="1.8" />
      <path d="M32 33v6M29 36h6" />
    </svg>
  )
}
