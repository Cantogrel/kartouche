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

// Valide les boîtes de dialogue d'un programme (bouton « Oui » / « OK » invoqué par UI Automation) : l'installation d'un firmware RPCS3 demande « Install firmware? »
// puis affiche « Successfully installed », deux clics que l'utilisateur ne doit pas avoir à faire. S'arrête avec RomVault.
const CONFIRM_SCRIPT = `param([int]$ParentPid, [string]$Proc, [string]$Names, [string]$Seen = '')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$wanted = $Names -split ','
$root = [System.Windows.Automation.AutomationElement]::RootElement
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  $ids = @((Get-Process -Name $Proc -ErrorAction SilentlyContinue).Id)
  if ($ids.Count -gt 0) {
    foreach ($w in $root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) {
      if ($ids -notcontains $w.Current.ProcessId) { continue }
      if ($Seen) {
        foreach ($t in $w.FindAll('Descendants', (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))) {
          if ($t.Current.Name.StartsWith($Seen)) { Write-Output 'SEEN' }
        }
      }
      foreach ($b in $w.FindAll('Descendants', (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))) {
        if ($wanted -contains $b.Current.Name) { try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Write-Output ('CLICK ' + $b.Current.Name) } catch {} }
      }
    }
  }
  Start-Sleep -Milliseconds 400
}
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

/**
 * Valide en continu les boîtes de dialogue (boutons `names`) des processus nommés `proc` ; renvoie la fonction d'arrêt. `seen` : texte de début d'un message dont
 * l'apparition est signalée par `onSeen` (sans le valider).
 */
export async function autoConfirmDialogs(cacheDir: string, proc: string, names: string[], seen?: { text: string; onSeen: () => void }): Promise<() => void> {
  const file = await scriptFile(cacheDir, 'auto-confirm.ps1', CONFIRM_SCRIPT)
  const child = spawn('powershell.exe', [...PS_ARGS, file, '-ParentPid', String(process.pid), '-Proc', proc, '-Names', names.join(','), ...(seen ? ['-Seen', seen.text] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.on('data', (d) => { if (seen && String(d).includes('SEEN')) seen.onSeen() })
  child.on('error', () => {})
  return () => { child.kill() }
}

/** Ferme un programme proprement (fenêtres fermées, l'émulateur sauvegarde et quitte), puis de force s'il ne répond pas dans `graceMs` (5 s par défaut). */
export function closeGracefully(pid: number, graceMs = 5000): void {
  execFile('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true }, () => {})
  setTimeout(() => {
    try { process.kill(pid, 0) } catch { return }
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  }, graceMs).unref()
}
