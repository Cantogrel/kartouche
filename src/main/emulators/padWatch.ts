import { spawn } from 'node:child_process'
import type { RawPad } from '@shared/pads'
import { NINTENDO_VID } from '@shared/pads'
import { PS_ARGS, scriptFile } from './quit'

// Deux surveillances PowerShell persistantes, qui s'arrêtent d'elles-mêmes avec Kartouche :
//  - la liste des manettes branchées (XInput + RawGameController de Windows), sans qu'il faille appuyer sur un bouton ;
//  - la lecture brute des manettes Nintendo (Joy-Con, Switch Pro), qui n'est pas du XInput : activité, et combinaison Moins + Plus.

// Windows liste les manettes par RawGameController (VID/PID, nom, sans fil) dès qu'elles sont connectées ; la liste ne se remplit que si les messages sont pompés.
// Une ligne JSON à chaque changement : { xi: [{ s: emplacement, v: vid, p: pid }], hid: [{ v, p, n: nom, w: sans fil }] }.
const LIST_SCRIPT = `param([int]$ParentPid)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
$null = [Windows.Gaming.Input.RawGameController, Windows.Gaming.Input, ContentType=WindowsRuntime]
Add-Type @"
using System; using System.Runtime.InteropServices;
public class XL {
  [StructLayout(LayoutKind.Sequential)] public struct GP { public ushort Buttons; public byte LT, RT; public short LX, LY, RX, RY; }
  [StructLayout(LayoutKind.Sequential)] public struct ST { public uint Packet; public GP Pad; }
  [StructLayout(LayoutKind.Sequential)] public struct CAPS { public byte Type, SubType; public ushort Flags; public ushort Buttons; public byte LT, RT; public short LX, LY, RX, RY; public ushort VL, VR; public ushort Vid, Pid, Ver, U1, U2; }
  [DllImport("xinput1_4.dll", EntryPoint="#108")] public static extern int Ex(int one, int idx, int flags, out CAPS c);
  [DllImport("xinput1_4.dll")] public static extern int XInputGetState(int i, out ST s);
}
"@
$last = ''
# Windows met un instant à remplir la liste des manettes : sans cette attente, la première ligne dirait « aucune manette ».
$w = [Diagnostics.Stopwatch]::StartNew()
while ($w.ElapsedMilliseconds -lt 1500) { [System.Windows.Forms.Application]::DoEvents(); $null = @([Windows.Gaming.Input.RawGameController]::RawGameControllers).Count; Start-Sleep -Milliseconds 100 }
while ($true) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  [System.Windows.Forms.Application]::DoEvents()
  $xi = @()
  for ($i = 0; $i -lt 4; $i++) {
    $s = New-Object XL+ST
    if ([XL]::XInputGetState($i, [ref]$s) -ne 0) { continue }
    $c = New-Object XL+CAPS
    $v = 0; $p = 0
    try { if ([XL]::Ex(1, $i, 0, [ref]$c) -eq 0) { $v = [int]$c.Vid; $p = [int]$c.Pid } } catch {}
    $xi += ('{{"s":{0},"v":{1},"p":{2}}}' -f $i, $v, $p)
  }
  $hid = @()
  try {
    foreach ($c in [Windows.Gaming.Input.RawGameController]::RawGameControllers) {
      $n = ([string]$c.DisplayName).Replace([string][char]92, '').Replace('"', '')
      $hid += ('{{"v":{0},"p":{1},"n":"{2}","w":{3}}}' -f [int]$c.HardwareVendorId, [int]$c.HardwareProductId, $n, ([string]$c.IsWireless).ToLower())
    }
  } catch {}
  $json = '{"xi":[' + ($xi -join ',') + '],"hid":[' + ($hid -join ',') + ']}'
  if ($json -ne $last) { $last = $json; [Console]::Out.WriteLine($json); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 600
}
`

/** Une ligne de `LIST_SCRIPT` : les manettes qu'elle décrit ; null si la ligne n'est pas lisible. */
export function parseListLine(line: string): RawPad[] | null {
  let j: { xi?: { s: number; v: number; p: number }[]; hid?: { v: number; p: number; n: string; w: boolean }[] }
  try { j = JSON.parse(line) } catch { return null }
  if (!j || !Array.isArray(j.xi) || !Array.isArray(j.hid)) return null
  return [
    ...j.xi.map((x): RawPad => ({ source: 'xinput', slot: x.s, vid: x.v, pid: x.p })),
    ...j.hid.map((h): RawPad => ({ source: 'hid', vid: h.v, pid: h.p, name: h.n, wireless: !!h.w }))
  ]
}

/**
 * Surveille les manettes branchées ; `onChange` reçoit la liste complète à chaque changement (et une première fois au démarrage). Renvoie la fonction d'arrêt.
 * `onEnd` est appelé si le processus se termine tout seul (PowerShell absent ou en échec).
 */
export async function watchPadList(cacheDir: string, onChange: (raw: RawPad[]) => void, onEnd?: () => void): Promise<() => void> {
  const file = await scriptFile(cacheDir, 'pads-list.ps1', LIST_SCRIPT)
  const child = spawn('powershell.exe', [...PS_ARGS, file, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = parseListLine(buf.slice(0, i).trim())
      buf = buf.slice(i + 1)
      if (raw) onChange(raw)
    }
  })
  child.on('error', () => onEnd?.())
  child.on('exit', () => onEnd?.())
  return () => { child.kill() }
}

// Rapports « complets » (0x30) des manettes Nintendo, lus sur l'interface HID sans la verrouiller (partage lecture/écriture, lecture seule) : octet 3 = boutons du Joy-Con droit,
// octet 4 = Moins (bit 0) et Plus (bit 1), octet 5 = boutons du Joy-Con gauche, octets 6 à 11 = les deux sticks (12 bits chacun). Relevé sur de vraies manettes, voir le vault
// (projects/romvault/manettes-nintendo-phase0). Sorties : « ACT <pid> » (bouton ou stick franchement actionné, au plus 4 par seconde et par manette) et « CHORD 1/0 »
// (Moins + Plus tenus ensemble : sur la Pro, ou Moins du Joy-Con gauche + Plus du Joy-Con droit ; un Joy-Con seul : Moins + Capture (gauche) ou Home + Plus (droit), octet 4 bits 0x20 et 0x10), et « DEV <pid> 1/0 »
// (manette Nintendo ouverte / perdue : sert à savoir ce qui est branché sans relancer de détection).
export const HID_SCRIPT = `param([int]$ParentPid)
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class NHid {
  [StructLayout(LayoutKind.Sequential)] struct SPD { public int cbSize; public Guid g; public int flags; public IntPtr r; }
  [StructLayout(LayoutKind.Sequential)] struct ATTR { public int size; public ushort vid, pid, ver; }
  [DllImport("setupapi.dll", SetLastError=true)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr h, int f);
  [DllImport("setupapi.dll", SetLastError=true)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr s, IntPtr d, ref Guid g, int i, ref SPD o);
  [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr s, ref SPD d, IntPtr det, int size, out int req, IntPtr di);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr s);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string n, uint a, uint s, IntPtr sec, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(SafeFileHandle h, byte[] b, int n, out int r, IntPtr o);
  [DllImport("hid.dll")] static extern bool HidD_GetAttributes(SafeFileHandle h, ref ATTR a);
  [DllImport("hid.dll")] static extern bool HidD_GetHidGuid(out Guid g);
  [DllImport("hid.dll")] static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr p);
  [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr p);
  [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr p, byte[] caps);
  static readonly HashSet<string> open = new HashSet<string>();
  static readonly HashSet<string> ignored = new HashSet<string>();
  static readonly Dictionary<string, int> tries = new Dictionary<string, int>();
  static void Ignore(string path, bool now) { lock (open) { int n = 0; tries.TryGetValue(path, out n); n++; tries[path] = n; if (now || n >= 5) ignored.Add(path); } }
  static readonly object gate = new object();
  // État PAR MANETTE (chemin HID) : avec deux manettes du même modèle (deux Switch Pro), un état par modèle se faisait écraser à chaque rapport de la manette
  // au repos et la combinaison Moins + Plus n'était jamais vue. La combinaison est vraie si une même Pro a Moins ET Plus, ou si un Joy-Con gauche a Moins
  // et un Joy-Con droit a Plus, etc. (n'importe quelles manettes présentes).
  class Dev { public ushort pid; public bool minus, plus, cap, home; }
  static readonly Dictionary<string, Dev> devs = new Dictionary<string, Dev>();
  // Ordre d'ouverture des manettes (ordre d'énumération de Windows, comme la liste des manettes) : le rang d'une manette parmi celles du même modèle dit LAQUELLE de plusieurs Switch Pro (ou Joy-Con du même côté) vient d'être actionnée.
  static readonly List<string> order = new List<string>();
  static int Ord(string path, ushort pid) { lock (gate) { int k = 0; foreach (string p in order) { if (p == path) return k; Dev v; if (devs.TryGetValue(p, out v) && v.pid == pid) k++; } } return 0; }
  static bool chord;
  static void Emit(string s) { lock (gate) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
  static void Chord() {
    bool pro = false, lm = false, rp = false, lc = false, rh = false;
    foreach (Dev v in devs.Values) {
      if (v.pid == 0x2009) { if (v.minus && v.plus) pro = true; }
      else if (v.pid == 0x2006) { if (v.minus) lm = true; if (v.cap) lc = true; }
      else if (v.pid == 0x2007) { if (v.plus) rp = true; if (v.home) rh = true; }
    }
    bool c = pro || (lm && rp) || (lm && lc) || (rh && rp);
    if (c != chord) { chord = c; Emit(c ? "CHORD 1" : "CHORD 0"); }
  }
  static int[] Sticks(byte[] b) { return new int[] { b[6] | ((b[7] & 15) << 8), (b[7] >> 4) | (b[8] << 4), b[9] | ((b[10] & 15) << 8), (b[10] >> 4) | (b[11] << 4) }; }
  public static void Scan() {
    Guid g; HidD_GetHidGuid(out g);
    IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12);
    SPD d = new SPD(); d.cbSize = Marshal.SizeOf(d);
    for (int i = 0; SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d); i++) {
      int req; SetupDiGetDeviceInterfaceDetail(set, ref d, IntPtr.Zero, 0, out req, IntPtr.Zero);
      IntPtr buf = Marshal.AllocHGlobal(req);
      Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
      string path = null;
      if (SetupDiGetDeviceInterfaceDetail(set, ref d, buf, req, out req, IntPtr.Zero)) path = Marshal.PtrToStringUni(IntPtr.Add(buf, 4));
      Marshal.FreeHGlobal(buf);
      if (path == null) continue;
      lock (open) { if (open.Contains(path) || ignored.Contains(path)) continue; }
      // Une manette Bluetooth ou USB réelle porte son identifiant (« vid_057e ») dans son chemin Windows ; une manette virtuelle (pont Freebox Pop → PC, pilote de
      // manette virtuelle) a un chemin « hid#hidclass#… » sans rien : on lit alors son vrai fabricant par HidD_GetAttributes. Un chemin sans identifiant n'est essayé
      // qu'une fois (périphérique ouvert et pas Nintendo) ou quelques fois (ouverture refusée, ex. clavier), puis ignoré : pas de réouverture de tous les HID à chaque tour.
      bool named = path.IndexOf("vid&0002057e", StringComparison.OrdinalIgnoreCase) >= 0 || path.IndexOf("vid_057e", StringComparison.OrdinalIgnoreCase) >= 0;
      SafeFileHandle h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h.IsInvalid) { if (!named) Ignore(path, false); continue; }
      ATTR a = new ATTR(); a.size = Marshal.SizeOf(a);
      IntPtr pp; int len = 0;
      if (!HidD_GetAttributes(h, ref a) || a.vid != 0x057E) { if (!named) Ignore(path, true); h.Dispose(); continue; }
      if (HidD_GetPreparsedData(h, out pp)) { byte[] caps = new byte[64]; if (HidP_GetCaps(pp, caps) == 0x110000) len = BitConverter.ToUInt16(caps, 4); HidD_FreePreparsedData(pp); }
      if (len < 12) { h.Dispose(); continue; }
      lock (open) { open.Add(path); }
      SafeFileHandle hh = h; string pth = path; ushort pid = a.pid; int ln = len;
      Thread t = new Thread(delegate() { Read(hh, pth, pid, ln); });
      t.IsBackground = true; t.Start();
      Emit("DEV " + pid.ToString("x") + " 1");
    }
    SetupDiDestroyDeviceInfoList(set);
  }
  static void Read(SafeFileHandle h, string path, ushort pid, int len) {
    byte[] b = new byte[len]; int[] baseline = null; int[] base3f = null; long lastAct = 0;
    Dev me = new Dev(); me.pid = pid;
    lock (gate) { devs[path] = me; order.Remove(path); order.Add(path); }
    try {
      while (true) {
        int r;
        if (!ReadFile(h, b, b.Length, out r, IntPtr.Zero) || r < 12) break;
        if (b[0] == 0x3F) {
          // Rapport « simple » (manette qui clignote : aucun programme ne l'a encore initialisée) : octets 1 et 2 = boutons, 3 = croix (8 = neutre), 4 à 11 = quatre axes de 16 bits (centre 0x8000).
          int[] ax = new int[] { b[4] | (b[5] << 8), b[6] | (b[7] << 8), b[8] | (b[9] << 8), b[10] | (b[11] << 8) };
          if (base3f == null) base3f = ax;
          // Moins = bit 0 et Plus = bit 1 de l'octet 2 (relevé sur la Switch Pro) : la fermeture du jeu à la manette doit marcher aussi dans ce format (DuckStation, PCSX2… dont le pilote SDL ne passe pas la manette en rapports complets).
          bool minus3 = (b[2] & 1) != 0, plus3 = (b[2] & 2) != 0;
          lock (gate) { me.minus = minus3; me.plus = plus3; Chord(); }
          bool simple = (b[1] | b[2]) != 0 || b[3] != 8;
          for (int k = 0; k < 4 && !simple; k++) if (Math.Abs(ax[k] - base3f[k]) > 9000) simple = true;
          long t3 = Environment.TickCount;
          if (simple && t3 - lastAct > 250) { lastAct = t3; Emit("ACT " + pid.ToString("x") + " " + Ord(path, pid)); }
          continue;
        }
        if (b[0] != 0x30) continue;
        bool minus = (b[4] & 1) != 0, plus = (b[4] & 2) != 0, home = (b[4] & 0x10) != 0, cap = (b[4] & 0x20) != 0;
        lock (gate) { me.minus = minus; me.plus = plus; me.cap = cap; me.home = home; Chord(); }
        int[] s = Sticks(b);
        if (baseline == null) baseline = s;
        bool active = (b[3] | b[4] | b[5]) != 0;
        for (int k = 0; k < 4 && !active; k++) if (Math.Abs(s[k] - baseline[k]) > 700) active = true;
        long now = Environment.TickCount;
        if (active && now - lastAct > 250) { lastAct = now; Emit("ACT " + pid.ToString("x") + " " + Ord(path, pid)); }
      }
    } finally {
      lock (gate) { devs.Remove(path); order.Remove(path); Chord(); }
      lock (open) { open.Remove(path); }
      Emit("DEV " + pid.ToString("x") + " 0");
      h.Dispose();
    }
  }
}
'@
while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
  try { [NHid]::Scan() } catch {}
  Start-Sleep -Seconds 3
}
`

export type NintendoEvent = { type: 'active'; pid: number; ord?: number } | { type: 'chord'; down: boolean } | { type: 'device'; pid: number; present: boolean }

/** Une ligne de `HID_SCRIPT` ; null si ce n'est pas un évènement. */
export function parseHidLine(line: string): NintendoEvent | null {
  const a = /^ACT ([0-9a-f]{1,4})(?: (\d{1,2}))?$/.exec(line)
  if (a) return a[2] === undefined ? { type: 'active', pid: parseInt(a[1], 16) } : { type: 'active', pid: parseInt(a[1], 16), ord: parseInt(a[2], 10) }
  const c = /^CHORD ([01])$/.exec(line)
  if (c) return { type: 'chord', down: c[1] === '1' }
  const d = /^DEV ([0-9a-f]{1,4}) ([01])$/.exec(line)
  if (d) return { type: 'device', pid: parseInt(d[1], 16), present: d[2] === '1' }
  return null
}

/** Surveille les manettes Nintendo (voir plus haut). Renvoie la fonction d'arrêt. Sans effet visible si aucune n'est branchée. */
export async function watchNintendoHid(cacheDir: string, onEvent: (e: NintendoEvent) => void): Promise<() => void> {
  const file = await scriptFile(cacheDir, 'pads-nintendo.ps1', HID_SCRIPT)
  const child = spawn('powershell.exe', [...PS_ARGS, file, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const e = parseHidLine(buf.slice(0, i).trim())
      buf = buf.slice(i + 1)
      if (e) onEvent(e)
    }
  })
  child.on('error', () => {})
  return () => { child.kill() }
}

/** Vrai si la liste contient au moins une manette Nintendo (pour ne lancer la lecture HID que si elle sert). */
export const hasNintendo = (raw: readonly RawPad[]): boolean => raw.some((r) => r.source === 'hid' && r.vid === NINTENDO_VID)
