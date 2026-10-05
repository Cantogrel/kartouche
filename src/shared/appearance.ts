export const RADII = ['sharp', 'normal', 'round'] as const
export type Radius = (typeof RADII)[number]

/** Valeurs de `--radius` / `--radius-lg` pour chaque arrondi. */
export const RADIUS_PX: Record<Radius, [number, number]> = { sharp: [2, 4], normal: [6, 10], round: [10, 18] }

export const isHexColor = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s)

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** Rapport de contraste WCAG (1 à 21) entre deux couleurs #rrggbb. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Texte lisible (noir ou blanc) sur un fond d'accent. */
export const readableOn = (bg: string): string => (contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#0e0e0e') ? '#ffffff' : '#0e0e0e')

/** Fonds de l'interface, par thème : sert à vérifier qu'un accent personnel reste visible. */
export const SURFACE: Record<'light' | 'dark', string> = { dark: '#161616', light: '#ffffff' }

/** Un accent personnel doit se détacher du fond (≥ 3:1, seuil WCAG des éléments graphiques). */
export const accentReadable = (hex: string, theme: 'light' | 'dark'): boolean => contrastRatio(hex, SURFACE[theme]) >= 3
