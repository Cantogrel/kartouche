const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Toujours 3 chiffres significatifs, unité adaptée : 560 KB, 3.52 MB, 59.1 MB, 876 MB, 2.84 GB. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++ }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(decimals)} ${UNITS[unit]}`
}

/** Durée de jeu lisible : 45 min, 2 h, 2 h 30 (les secondes ne comptent pas). */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r === 0 ? `${h} h` : `${h} h ${String(r).padStart(2, '0')}`
}
