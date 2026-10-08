import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createChordHold, nintendoChordDown, onNintendoChord } from './nintendoChord'

/** Combinaison de manette pour quitter un jeu : Retour + Start maintenus (XInput : Xbox et manettes compatibles) ou Moins + Plus maintenus (Switch Pro, paire de Joy-Cons, voir `nintendoChord.ts`). */
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

// Manette sur laquelle on appuie : une ligne « emplacement » à chaque nouvel appui (bouton, gâchette ou stick franchement incliné). Sondé toutes les 100 ms, s'arrête avec Kartouche.
const ACTIVITY_SCRIPT = `param([int]$ParentPid)
${XINPUT_TYPE}$last = @(-1, -1, -1, -1)
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  for ($i = 0; $i -lt 4; $i++) {
    $s = New-Object XI+ST
    if ([XI]::XInputGetState($i, [ref]$s) -ne 0) { $last[$i] = -1; continue }
    $p = $s.Pad
    $active = ($p.Buttons -ne 0) -or ($p.LT -gt 100) -or ($p.RT -gt 100) -or ([math]::Abs($p.LX) -gt 16000) -or ([math]::Abs($p.LY) -gt 16000) -or ([math]::Abs($p.RX) -gt 16000) -or ([math]::Abs($p.RY) -gt 16000)
    if ($active -and $s.Packet -ne $last[$i]) { Write-Output $i }
    $last[$i] = $s.Packet
  }
  Start-Sleep -Milliseconds 100
}
`

const SLOTS_SCRIPT =`${XINPUT_TYPE}$found = @()
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

// Applet Contrôleur d'Eden : quand un jeu demande de vérifier ou d'assigner les manettes (Mario Kart à deux joueurs…), Eden ouvre une fenêtre à valider. Les manettes sont déjà
// assignées par Kartouche : on clique « OK » à la place de l'utilisateur. Relevé sur Eden 0.2.1 (UI Automation) : la fenêtre est une fenêtre propriétaire de la fenêtre principale
// (titre « Applet Contrôleur » en français), et ses boutons ont tous l'identifiant « …QtControllerSelectorDialog…closeButtons.buttonBox.QPushButton » (OK et Annuler : même
// identifiant, seuls le nom, traduit, et la position changent). On prend donc le bouton le plus à gauche (disposition Windows : OK puis Annuler), quelle que soit la langue.
// Le bouton OK est grisé tant que la configuration ne convient pas au jeu (type de manette refusé, nombre de joueurs) : il n'est alors pas cliqué. S'il reste grisé plus de
// 1,5 s, le script écrit « REFUSED » : Kartouche ferme le jeu et explique clairement ce qu'il faut brancher. La recherche UI Automation, lourde, n'est lancée que si une fenêtre
// propriétaire visible existe (test Win32 bon marché).
const EDEN_APPLET_SCRIPT = `param([int]$ParentPid, [string]$Proc = 'eden')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class EW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public static bool HasVisibleOwned(HashSet<uint> pids) {
    bool found = false;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h) && GetWindow(h, 4) != IntPtr.Zero) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$id = 'QApplication.QtControllerSelectorDialog.mainControllerApplet.bottomControllerApplet.closeButtons.buttonBox.QPushButton'
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
$refusedSince = $null
$reported = $false
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  $procs = @(Get-Process -Name $Proc -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 0) {
    $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($p in $procs) { [void]$set.Add([uint32]$p.Id) }
    $applet = $false
    if ([EW]::HasVisibleOwned($set)) {
      foreach ($w in $root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) {
        if (-not $set.Contains([uint32]$w.Current.ProcessId)) { continue }
        $buttons = @($w.FindAll('Descendants', $cond) | Sort-Object { $_.Current.BoundingRectangle.X })
        if ($buttons.Count -lt 2) { continue }
        $applet = $true
        if ($buttons[0].Current.IsEnabled) {
          $refusedSince = $null
          Write-Output 'APPLET-OK-ENABLED'
          try { $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Write-Output 'CLICK'; Start-Sleep -Milliseconds 1500 } catch {}
        } else {
          if ($null -eq $refusedSince) { $refusedSince = [Diagnostics.Stopwatch]::StartNew(); Write-Output 'APPLET-OK-DISABLED' }
          if (-not $reported -and $refusedSince.ElapsedMilliseconds -gt 1500) { Write-Output 'REFUSED'; $reported = $true }
        }
      }
    }
    if (-not $applet) { $refusedSince = $null; $reported = $false }
  }
  Start-Sleep -Milliseconds 300
}
`

export async function scriptFile(cacheDir: string, name: string, content: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true })
  const file = join(cacheDir, name)
  await writeFile(file, content)
  return file
}

export const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

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

/** Surveille les manettes : `onPress(emplacement)` à chaque appui sur l'une d'elles. Renvoie la fonction d'arrêt. */
export async function watchPadActivity(cacheDir: string, onPress: (slot: number) => void): Promise<() => void> {
  const file = await scriptFile(cacheDir, 'xinput-activity.ps1', ACTIVITY_SCRIPT)
  const child = spawn('powershell.exe', [...PS_ARGS, file, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.on('data', (d) => { for (const m of String(d).matchAll(/^([0-3])\s*$/gm)) onPress(Number(m[1])) })
  child.on('error', () => {})
  return () => { child.kill() }
}

/** Surveille la manette pendant une partie ; `onChord` est appelé quand Retour + Start (XInput) ou Moins + Plus (Nintendo) sont maintenus. Renvoie la fonction d'arrêt. */
export async function watchQuitChord(cacheDir: string, onChord: () => void): Promise<() => void> {
  const file = await scriptFile(cacheDir, 'quit-watch.ps1', WATCH_SCRIPT)
  const child = spawn('powershell.exe', [...PS_ARGS, file, '-ParentPid', String(process.pid), '-HoldMs', String(QUIT_HOLD_MS)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.on('data', (d) => { if (String(d).includes('QUIT')) onChord() })
  child.on('error', () => {})
  const hold = createChordHold(QUIT_HOLD_MS, onChord, nintendoChordDown())
  const off = onNintendoChord(hold.feed)
  return () => { child.kill(); off(); hold.cancel() }
}

/**
 * Valide l'applet Contrôleur d'Eden (voir `EDEN_APPLET_SCRIPT`) tant que Kartouche tourne ; renvoie la fonction d'arrêt. `onRefused` est appelé (une fois par ouverture de
 * l'applet) quand le jeu refuse la configuration des manettes : le bouton OK reste grisé.
 */
export async function autoConfirmEdenApplet(cacheDir: string, onRefused?: () => void): Promise<() => void> {
  const file = await scriptFile(cacheDir, 'eden-applet.ps1', EDEN_APPLET_SCRIPT)
  const child = spawn('powershell.exe', [...PS_ARGS, file, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  // Trace de ce que l'applet a affiché (état du bouton OK, refus) : aide à comprendre un jeu qui ne se ferme pas ou une applet validée à tort.
  child.stdout.on('data', (d) => {
    const lines = String(d).split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean)
    void appendFile(join(cacheDir, 'eden-applet.log'), `${new Date().toISOString()} ${lines.join(' | ')}${String.fromCharCode(10)}`).catch(() => {})
    if (String(d).includes('REFUSED')) onRefused?.()
  })
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
