import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Détection du GPU (API graphique et niveau de puissance), commune aux émulateurs dont les réglages en dépendent (Cemu, Dolphin).

export type GpuTier = 'igpu' | 'low' | 'mid' | 'high'
/** `name` : nom du GPU choisi (celui que Vulkan annonce, utilisable pour désigner le périphérique à un émulateur) ; absent si rien n'a pu être détecté. */
export interface Gpu { vulkan: boolean; tier: GpuTier; name?: string }

/** Valeur par défaut quand rien n'a pu être détecté : Vulkan (défaut de Cemu sous Windows), pas d'hypothèse de puissance. */
export const DEFAULT_GPU: Gpu = { vulkan: true, tier: 'mid' }

export interface GpuAdapter { name: string; ramBytes: number }

const VIRTUAL_ADAPTER = /microsoft basic|remote|virtual|vmware|parsec|indirect|displaylink|meta /i
const INTEGRATED_GPU = /\bintel(?!.*\barc\b)|radeon(\(tm\))?\s+(graphics|vega\s*\d+|\d{3}m\b)/i
/** Intel d'avant la génération 9 (Skylake) : pas de pilote Vulkan Windows utilisable par Cemu → OpenGL. */
const OLD_INTEL_GPU = /intel.*(hd graphics\s*(?:\d{4}|p\d{4})?\s*$|hd graphics\s*(?:2\d{3}|3\d{3}|4\d{3}|5\d{3}|6000)\b|iris.*(?:5100|5200|6100|6200))/i
const HIGH_END_GPU = /\bRTX\b|RX\s*(?:6[6-9]\d{2}|7\d{3}|9\d{3})|Arc\s*A[57]/i

/** Choisit l'adaptateur qui fera tourner Cemu (le discret le plus doté en VRAM) et en déduit API et niveau de puissance. `vulkanLoader` : vulkan-1.dll présent (installé par les pilotes). */
export function classifyGpu(adapters: readonly GpuAdapter[], vulkanLoader: boolean): Gpu {
  const real = adapters.filter((a) => a.name && !VIRTUAL_ADAPTER.test(a.name))
  if (!real.length) return { vulkan: vulkanLoader, tier: DEFAULT_GPU.tier }
  const discrete = real.filter((a) => !INTEGRATED_GPU.test(a.name)).sort((a, b) => b.ramBytes - a.ramBytes)
  const best = discrete[0] ?? real[0]
  const integrated = INTEGRATED_GPU.test(best.name)
  // AdapterRAM est un entier 32 bits : plafonné à 4 Go (valeur saturée) pour toute carte plus grande.
  const tier: GpuTier = integrated ? 'igpu' : best.ramBytes > 0 && best.ramBytes < 3 * 1024 ** 3 ? 'low' : HIGH_END_GPU.test(best.name) ? 'high' : 'mid'
  return { vulkan: vulkanLoader && !OLD_INTEL_GPU.test(best.name), tier, name: best.name }
}

/** Détecte le GPU (PowerShell/CIM, 8 s max). Toute erreur → réglages par défaut. */
export async function detectGpu(): Promise<Gpu> {
  const vulkanLoader = existsSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'vulkan-1.dll'))
  const adapters = await new Promise<GpuAdapter[]>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return resolve([])
        try {
          const raw = JSON.parse(stdout) as { Name?: string; AdapterRAM?: number } | { Name?: string; AdapterRAM?: number }[]
          resolve((Array.isArray(raw) ? raw : [raw]).map((r) => ({ name: r.Name ?? '', ramBytes: r.AdapterRAM ?? 0 })))
        } catch { resolve([]) }
      })
  })
  return adapters.length ? classifyGpu(adapters, vulkanLoader) : { ...DEFAULT_GPU, vulkan: vulkanLoader }
}
