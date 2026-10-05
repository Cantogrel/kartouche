import { nativeImage } from 'electron'
import type { ImageType } from './customArt'

/** Plus grand côté conservé : une jaquette ou un fond n'a pas besoin de plus, et une photo de 8000 px ralentirait l'affichage. */
export const MAX_IMAGE_SIDE = 2560

/**
 * Réduit une image trop grande (Electron : `nativeImage`). Une image dans la limite, ou qu'Electron ne sait pas lire, est gardée telle quelle.
 * `nativeImage` n'écrit pas de WebP : une WebP trop grande est réécrite en PNG.
 */
export function downscaleImage(data: Buffer, type: ImageType): { data: Buffer; type: ImageType } {
  const img = nativeImage.createFromBuffer(data)
  if (img.isEmpty()) return { data, type }
  const { width, height } = img.getSize()
  const longest = Math.max(width, height)
  if (longest <= MAX_IMAGE_SIDE) return { data, type }
  const k = MAX_IMAGE_SIDE / longest
  const small = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' })
  return type === 'jpg' ? { data: small.toJPEG(92), type: 'jpg' } : { data: small.toPNG(), type: 'png' }
}
