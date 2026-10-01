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
