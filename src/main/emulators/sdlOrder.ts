import { execFile } from 'node:child_process'
import { PS_ARGS, scriptFile } from './quit'
import type { SupportedPlayer } from './mainPad'

// DuckStation et PCSX2 désignent les manettes SDL par un numéro (« SDL-0 », « SDL-1 »…) : l'indice de joueur que SDL donne à chaque manette quand l'émulateur démarre (la journalisation de PCSX2 le
// dit : « Opened gamepad 3 (instance id 3, player id 0) … Manette SDL-0 connectée »). Il ne suit pas l'ordre de branchement (SDL reprend le motif de LED que la manette affiche : une Pro qui
// montrait trois LED est le joueur 3). Pour que le joueur 2 lise la bonne manette il faut donc demander à SDL, juste avant le lancement, quel numéro porte chacune : ce script charge la même DLL SDL3
// que l'émulateur, laisse les manettes se déclarer, et les liste sans les ouvrir (donc sans changer leurs LED).
const SCRIPT = `param([string]$Dll)
$env:PATH = (Split-Path -Parent $Dll) + ';' + $env:PATH
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class L {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibrary(string p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool SetDllDirectory(string p);
  [DllImport("SDL3.dll")] public static extern bool SDL_Init(uint f);
  [DllImport("SDL3.dll")] public static extern IntPtr SDL_GetGamepads(out int count);
  [DllImport("SDL3.dll")] public static extern IntPtr SDL_GetGamepadNameForID(uint id);
  [DllImport("SDL3.dll")] public static extern ushort SDL_GetGamepadVendorForID(uint id);
  [DllImport("SDL3.dll")] public static extern ushort SDL_GetGamepadProductForID(uint id);
  [DllImport("SDL3.dll")] public static extern int SDL_GetGamepadPlayerIndexForID(uint id);
  [DllImport("SDL3.dll")] public static extern void SDL_PumpEvents();
}
'@
[L]::SetDllDirectory((Split-Path -Parent $Dll)) | Out-Null
[L]::LoadLibrary($Dll) | Out-Null
[L]::SDL_Init(0x2200) | Out-Null
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 2.5) { [L]::SDL_PumpEvents(); Start-Sleep -Milliseconds 50 }
$n = 0
$p = [L]::SDL_GetGamepads([ref]$n)
for ($i = 0; $i -lt $n; $i++) {
  $id = [uint32][Runtime.InteropServices.Marshal]::ReadInt32($p, 4 * $i)
  $name = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([L]::SDL_GetGamepadNameForID($id))
  Write-Output ('PAD {0} {1} {2} {3} {4} {5}' -f $i, $id, [L]::SDL_GetGamepadVendorForID($id), [L]::SDL_GetGamepadProductForID($id), [L]::SDL_GetGamepadPlayerIndexForID($id), $name)
}
Write-Output 'END'
`

export interface SdlPad { order: number; id: number; vid: number; pid: number; player: number; name: string }

/** Une ligne « PAD <ordre> <id> <vid> <pid> <joueur> <nom> » de `SCRIPT` ; null pour toute autre ligne. */
export function parseSdlPad(line: string): SdlPad | null {
  const m = /^PAD (\d+) (\d+) (\d+) (\d+) (-?\d+) (.+?)\s*$/.exec(line.trim())
  return m ? { order: Number(m[1]), id: Number(m[2]), vid: Number(m[3]), pid: Number(m[4]), player: Number(m[5]), name: m[6] } : null
}

/** Les manettes que SDL (la DLL `dll` de l'émulateur) voit, avec leur indice de joueur ; vide si la sonde échoue. */
export async function listSdlPads(cacheDir: string, dll: string): Promise<SdlPad[]> {
  try {
    const file = await scriptFile(cacheDir, 'sdl3-list.ps1', '﻿' + SCRIPT)
    return await new Promise<SdlPad[]>((resolve) => {
      execFile('powershell.exe', [...PS_ARGS, file, '-Dll', dll], { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve(err ? [] : String(stdout).split(/\r?\n/).map(parseSdlPad).filter((p): p is SdlPad => p !== null)))
    })
  } catch { return [] }
}

const NAME: Record<string, string> = { 'switch-pro': 'Nintendo Switch Pro Controller', 'joycon-pair': 'Nintendo Switch Joy-Con (L/R)' }
const MICROSOFT = 0x045e

/**
 * Le numéro « SDL-n » de chaque joueur (null si SDL ne voit pas sa manette) : une Switch Pro ou une paire par son nom, une XInput par le constructeur (Microsoft), `port` = rang parmi les
 * manettes de même identité (dans l'ordre de leur identifiant d'instance). Un numéro n'est jamais donné à deux joueurs.
 */
export function assignSdlNumbers(players: readonly SupportedPlayer[], devices: readonly SdlPad[]): (number | null)[] {
  const used = new Set<number>()
  return players.map((p) => {
    const same = devices.filter((d) => (p.kind === 'xinput' ? d.vid === MICROSOFT : d.name === NAME[p.kind])).sort((a, b) => a.id - b.id)
    const dev = same[p.port]
    if (!dev) return null
    const n = dev.player >= 0 ? dev.player : dev.order
    if (used.has(n)) return null
    used.add(n)
    return n
  })
}
