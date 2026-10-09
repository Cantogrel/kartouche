import { execFile } from 'node:child_process'
import { PS_ARGS, scriptFile } from './quit'
import type { SupportedPlayer } from './mainPad'

// RetroArch (pilote `sdl2`) désigne les manettes par leur rang parmi les joysticks que SDL2 voit (`input_player<n>_joypad_index`). Avec une Switch Pro ou une paire de Joy-Con plus une manette
// Xbox, ce rang dépend de l'ordre dans lequel SDL2 les énumère : on le lui demande juste avant le lancement, avec la DLL de RetroArch et les mêmes variables d'environnement que lui.
const SCRIPT = `param([string]$Dll)
$env:PATH = (Split-Path -Parent $Dll) + ';' + $env:PATH
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class J {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibrary(string p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool SetDllDirectory(string p);
  [DllImport("SDL2.dll")] public static extern int SDL_Init(uint f);
  [DllImport("SDL2.dll")] public static extern int SDL_NumJoysticks();
  [DllImport("SDL2.dll")] public static extern IntPtr SDL_JoystickNameForIndex(int i);
  [DllImport("SDL2.dll")] public static extern ushort SDL_JoystickGetDeviceVendor(int i);
  [DllImport("SDL2.dll")] public static extern ushort SDL_JoystickGetDeviceProduct(int i);
  [DllImport("SDL2.dll")] public static extern void SDL_PumpEvents();
}
'@
[J]::SetDllDirectory((Split-Path -Parent $Dll)) | Out-Null
[J]::LoadLibrary($Dll) | Out-Null
[J]::SDL_Init(0x200) | Out-Null
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt 2.5) { [J]::SDL_PumpEvents(); Start-Sleep -Milliseconds 50 }
$n = [J]::SDL_NumJoysticks()
for ($i = 0; $i -lt $n; $i++) {
  $name = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([J]::SDL_JoystickNameForIndex($i))
  Write-Output ('JOY {0} {1} {2} {3}' -f $i, [J]::SDL_JoystickGetDeviceVendor($i), [J]::SDL_JoystickGetDeviceProduct($i), $name)
}
Write-Output 'END'
`

export interface Sdl2Joystick { index: number; vid: number; pid: number; name: string }

export function parseSdl2Joystick(line: string): Sdl2Joystick | null {
  const m = /^JOY (\d+) (\d+) (\d+) (.+?)\s*$/.exec(line.trim())
  return m ? { index: Number(m[1]), vid: Number(m[2]), pid: Number(m[3]), name: m[4] } : null
}

/** Les joysticks que la SDL2 `dll` voit avec l'environnement `env`, par rang ; vide si la sonde échoue. */
export async function listSdl2Joysticks(cacheDir: string, dll: string, env: NodeJS.ProcessEnv | undefined): Promise<Sdl2Joystick[]> {
  try {
    const file = await scriptFile(cacheDir, 'sdl2-list.ps1', '﻿' + SCRIPT)
    return await new Promise<Sdl2Joystick[]>((resolve) => {
      execFile('powershell.exe', [...PS_ARGS, file, '-Dll', dll], { windowsHide: true, timeout: 15000, env }, (err, stdout) => resolve(err ? [] : String(stdout).split(/\r?\n/).map(parseSdl2Joystick).filter((j): j is Sdl2Joystick => j !== null)))
    })
  } catch { return [] }
}

const NAME: Record<string, string> = { 'switch-pro': 'Nintendo Switch Pro Controller', 'joycon-pair': 'Nintendo Switch Joy-Con (L/R)' }
const NINTENDO = 0x057e

/**
 * Le rang SDL2 de chaque joueur (null si SDL2 ne voit pas sa manette). Une Switch Pro ou une paire par son nom ; une XInput = n'importe quel joystick qui n'est pas de Nintendo, dans l'ordre
 * des emplacements XInput des joueurs. `port` : rang parmi les manettes Nintendo de même nom.
 */
export function assignSdl2Indexes(players: readonly SupportedPlayer[], joys: readonly Sdl2Joystick[]): (number | null)[] {
  const others = joys.filter((j) => j.vid !== NINTENDO).sort((a, b) => a.index - b.index)
  const slots = players.flatMap((p) => (p.kind === 'xinput' ? [p.slot] : [])).sort((a, b) => a - b)
  return players.map((p) => {
    if (p.kind === 'xinput') return others[slots.indexOf(p.slot)]?.index ?? null
    return joys.filter((j) => j.name === NAME[p.kind]).sort((a, b) => a.index - b.index)[p.port]?.index ?? null
  })
}
