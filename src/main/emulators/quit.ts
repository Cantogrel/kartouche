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

// Identité (VID/PID/version) de chaque manette XInput, comme SDL la lit pour construire le GUID de son pilote XInput (XInputGetCapabilitiesEx, ordinal 108 de xinput1_4.dll,
// non documenté mais utilisé par SDL). Une ligne « emplacement:vid:pid:version » (hexadécimal) par manette branchée ; vid/pid à 0 si l'appel échoue.
const PADS_SCRIPT = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class XC {
  [StructLayout(LayoutKind.Sequential)] public struct GP { public ushort Buttons; public byte LT, RT; public short LX, LY, RX, RY; }
  [StructLayout(LayoutKind.Sequential)] public struct ST { public uint Packet; public GP Pad; }
  [StructLayout(LayoutKind.Sequential)] public struct CAPS { public byte Type, SubType; public ushort Flags; public ushort Buttons; public byte LT, RT; public short LX, LY, RX, RY; public ushort VL, VR; public ushort Vid, Pid, Ver, U1, U2; }
  [DllImport("xinput1_4.dll", EntryPoint="#108")] public static extern int Ex(int one, int idx, int flags, out CAPS c);
  [DllImport("xinput1_4.dll")] public static extern int XInputGetState(int i, out ST s);
}
"@
for ($i = 0; $i -lt 4; $i++) {
  $s = New-Object XC+ST
  if ([XC]::XInputGetState($i, [ref]$s) -ne 0) { continue }
  $c = New-Object XC+CAPS
  $ok = $false
  try { $ok = ([XC]::Ex(1, $i, 0, [ref]$c) -eq 0) } catch {}
  if ($ok) { Write-Output ('{0}:{1:x}:{2:x}:{3:x}' -f $i, $c.Vid, $c.Pid, $c.Ver) } else { Write-Output ('{0}:0:0:0' -f $i) }
}
`

// Valide les boîtes de dialogue d'un programme (bouton « Oui » / « OK » invoqué par UI Automation) : l'installation d'un firmware RPCS3 demande « Install firmware? »
// puis affiche « Successfully installed », deux clics que l'utilisateur ne doit pas avoir à faire. S'arrête avec Kartouche.
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

export interface XInputPad { slot: number; vid: number; pid: number; ver: number }

/** Manettes XInput branchées avec leur identité (0 si illisible) ; vide si aucune ou si la détection échoue. */
export async function connectedXInputPads(cacheDir: string): Promise<XInputPad[]> {
  try {
    const file = await scriptFile(cacheDir, 'xinput-pads.ps1', PADS_SCRIPT)
    return await new Promise<XInputPad[]>((resolve) => {
      execFile('powershell.exe', [...PS_ARGS, file], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return resolve([])
        const pads: XInputPad[] = []
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^([0-3]):([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4})\s*$/i.exec(line.trim())
          if (m) pads.push({ slot: Number(m[1]), vid: parseInt(m[2], 16), pid: parseInt(m[3], 16), ver: parseInt(m[4], 16) })
        }
        resolve(pads)
      })
    })
  } catch { return [] }
}

// Manettes non XInput (HID brut) : interface « game controller » des manettes HID standard, plus les manettes Sony (DualShock 4, DualSense) et Nintendo (Pro Controller, Joy-Con) par leurs PID.
const HID_PADS_SCRIPT = "$ids = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'game controller|contr.leur de jeu|gamepad|joystick' -or $_.InstanceId -match 'VID_054C&PID_(05C4|09CC|0BA0|0CE6|0DF2)|VID_057E&PID_(2006|2007|2009|200E)' }; if ($ids) { Write-Output 'PAD' }"

/**
 * Une manette quelconque est-elle branchée ? XInput (Xbox et compatibles) ou HID brut (DualShock/DualSense, Switch Pro, manettes génériques). Sert aux émulateurs qui lisent les manettes par
 * leur mapping SDL standard (Azahar) : n'importe laquelle y répond, il suffit de savoir qu'il y en a une. Faux si rien n'est détecté ou si la détection échoue.
 */
export async function anyGamepadConnected(cacheDir: string): Promise<boolean> {
  if ((await connectedXInputSlots(cacheDir)).length > 0) return true
  return new Promise<boolean>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HID_PADS_SCRIPT], { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(!err && String(stdout).includes('PAD')))
  })
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
