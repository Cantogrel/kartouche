import { execFile, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Combinaison de manette pour quitter un jeu : Retour + Start maintenus (XInput : Xbox et manettes compatibles). */
export const QUIT_HOLD_MS = 1500

// XInput (manettes Xbox et compatibles) : Back = 0x0020, Start = 0x0010.
const XINPUT_TYPE = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class XI {
  [StructLayout(LayoutKind.Sequential)] public struct GP { public ushort Buttons; public byte LT, RT; public short LX, LY, RX, RY; }
  [StructLayout(LayoutKind.Sequential)] public struct ST { public uint Packet; public GP Pad; }
  [DllImport("xinput1_4.dll")] public static extern int XInputGetState(int i, out XI.ST s);
}
"@
`

// Sondé toutes les 100 ms tant que le jeu tourne.
const WATCH_SCRIPT = `param([int]$ParentPid, [int]$HoldMs)
${XINPUT_TYPE}$held = 0
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  $down = $false
  for ($i = 0; $i -lt 4; $i++) {
    $s = New-Object XI+ST
    if ([XI]::XInputGetState($i, [ref]$s) -eq 0 -and (($s.Pad.Buttons -band 0x30) -eq 0x30)) { $down = $true }
  }
  if ($down) { $held += 100 } else { $held = 0 }
  if ($held -ge $HoldMs) { Write-Output 'QUIT'; exit }
  Start-Sleep -Milliseconds 100
}
`

const SLOTS_SCRIPT = `${XINPUT_TYPE}$found = @()
for ($i = 0; $i -lt 4; $i++) {
  $s = New-Object XI+ST
  if ([XI]::XInputGetState($i, [ref]$s) -eq 0) { $found += $i }
}
Write-Output ($found -join ',')
`

async function scriptFile(cacheDir: string, name: string, content: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true })
  const file = join(cacheDir, name)
  await writeFile(file, content)
  return file
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

/** Numéros (0 à 3) des manettes XInput branchées ; vide si aucune ou si la détection échoue. */
export async function connectedXInputSlots(cacheDir: string): Promise<number[]> {
  try {
    const file = await scriptFile(cacheDir, 'xinput-slots.ps1', SLOTS_SCRIPT)
    return await new Promise<number[]>((resolve) => {
      execFile('powershell.exe', [...PS_ARGS, file], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return resolve([])
        resolve(String(stdout).trim().split(',').filter((x) => /^[0-3]$/.test(x)).map(Number))
      })
    })
  } catch { return [] }
}

/** Surveille la manette pendant une partie ; `onChord` est appelé quand Retour + Start sont maintenus. Renvoie la fonction d'arrêt. */
export async function watchQuitChord(cacheDir: string, onChord: () => void): Promise<() => void> {
  const file = await scriptFile(cacheDir, 'quit-watch.ps1', WATCH_SCRIPT)
  const child = spawn('powershell.exe', [...PS_ARGS, file, '-ParentPid', String(process.pid), '-HoldMs', String(QUIT_HOLD_MS)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.on('data', (d) => { if (String(d).includes('QUIT')) onChord() })
  child.on('error', () => {})
  return () => { child.kill() }
}

/** Ferme un programme proprement (fenêtres fermées, l'émulateur sauvegarde et quitte), puis de force s'il ne répond pas en 5 s. */
export function closeGracefully(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true }, () => {})
  setTimeout(() => {
    try { process.kill(pid, 0) } catch { return }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  }, 5000).unref()
}
