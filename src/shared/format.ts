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

/** Durée de jeu lisible : 45 min, 2.5 h (une décimale de 1 h à 99.9 h), 120 h (sans décimale dès 100 h). */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0))
  if (m < 60) return `${m} min`
  const tenths = Math.round(m / 6) // dixièmes d'heure
  if (tenths >= 1000) return `${Math.round(m / 60)} h`
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)} h`
}
