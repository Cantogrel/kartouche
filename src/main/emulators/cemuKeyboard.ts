import { spawn } from 'node:child_process'
import { PS_ARGS, scriptFile } from './quit'

// Le clavier à l'écran de Cemu (nom d'un profil, d'un joueur… : « Entrez votre nom ») est dessiné par Cemu lui-même (ImGui, voir swkbd.cpp) : ses touches sont des boutons à cliquer à la
// souris, aucune navigation à la manette. Pendant qu'il est affiché, ce script fait du stick droit un curseur de souris et de A un clic gauche ; le reste du temps il ne fait rien (le stick
// droit garde son rôle dans le jeu).
//
// Détection : Cemu n'écrit rien au journal et le clavier n'est pas une fenêtre (il est dessiné dans celle du jeu). Ses touches sont un aplat de couleur unique (91, 134, 168, relevé sur une
// capture) sur cinq rangées : on regarde l'image de la fenêtre du jeu deux fois par seconde et on cherche cette couleur en bandes horizontales (au moins quatre bandes bien remplies).
// Manettes lues : XInput (xinput1_4), Switch Pro et Joy-Con droit de la paire (lecture HID brute, rapports complets 0x30 ou simples 0x3F pour la Pro, comme `HID_SCRIPT`).
const SCRIPT = `param([int]$ParentPid, [int]$CemuPid)
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class CK {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct XS { public uint pk; public ushort btn; public byte lt, rt; public short lx, ly, rx, ry; }
  [StructLayout(LayoutKind.Sequential)] struct SPD { public int cbSize; public Guid g; public int flags; public IntPtr r; }
  [StructLayout(LayoutKind.Sequential)] struct ATTR { public int size; public ushort vid, pid, ver; }
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("xinput1_4.dll")] static extern int XInputGetState(int i, out XS s);
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

  // Etat de la Switch Pro (stick droit normalise -1..1, y vers le haut positif, et A), mis a jour par les fils de lecture.
  static volatile float proX, proY; static volatile bool proA;
  static readonly HashSet<string> open = new HashSet<string>();

  public static void ScanPro() {
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
      string low = path.ToLowerInvariant();
      // Switch Pro (2009) et Joy-Con droit (2007, le stick de la paire : sa position est celle du stick droit de la manette réunie).
      if (!(low.Contains("vid&0002057e") || low.Contains("vid_057e")) || !(low.Contains("pid&2009") || low.Contains("pid_2009") || low.Contains("pid&2007") || low.Contains("pid_2007"))) continue;
      bool right = low.Contains("2007");
      lock (open) { if (open.Contains(path)) continue; }
      SafeFileHandle h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h.IsInvalid) continue;
      IntPtr pp; int len = 0;
      if (HidD_GetPreparsedData(h, out pp)) { byte[] caps = new byte[64]; if (HidP_GetCaps(pp, caps) == 0x110000) len = BitConverter.ToUInt16(caps, 4); HidD_FreePreparsedData(pp); }
      if (len < 12) { h.Dispose(); continue; }
      lock (open) { open.Add(path); }
      SafeFileHandle hh = h; string pth = path; int ln = len; bool rt = right;
      Thread t = new Thread(delegate() { ReadPro(hh, pth, ln, rt); });
      t.IsBackground = true; t.Start();
    }
    SetupDiDestroyDeviceInfoList(set);
  }
  static void ReadPro(SafeFileHandle h, string path, int len, bool joyconRight) {
    byte[] b = new byte[len]; float cx = -1, cy = -1;
    try {
      while (true) {
        int r;
        if (!ReadFile(h, b, b.Length, out r, IntPtr.Zero) || r < 12) break;
        float x, y; bool a;
        if (b[0] == 0x30) {
          int rx = b[9] | ((b[10] & 15) << 8), ry = (b[10] >> 4) | (b[11] << 4);
          if (cx < 0) { cx = rx; cy = ry; }
          x = (rx - cx) / 1500f; y = (ry - cy) / 1500f; a = (b[3] & 0x08) != 0;
        } else if (b[0] == 0x3F && !joyconRight) {
          int rx = b[8] | (b[9] << 8), ry = b[10] | (b[11] << 8);
          if (cx < 0) { cx = rx; cy = ry; }
          // Rapport simple : l'axe vertical monte quand on pousse vers le bas (comme une coordonnee d'ecran).
          x = (rx - cx) / 24000f; y = -(ry - cy) / 24000f; a = (b[1] & 0x02) != 0;
        } else continue;
        proX = Math.Max(-1f, Math.Min(1f, x)); proY = Math.Max(-1f, Math.Min(1f, y)); proA = a;
      }
    } finally { proX = 0; proY = 0; proA = false; lock (open) { open.Remove(path); } h.Dispose(); }
  }

  // Rectangle (ecran) de la zone cliente de la fenetre du jeu.
  public static bool ClientBox(IntPtr hwnd, out int x, out int y, out int w, out int h) {
    x = y = w = h = 0; RECT r; if (hwnd == IntPtr.Zero || !GetClientRect(hwnd, out r)) return false;
    POINT p = new POINT(); if (!ClientToScreen(hwnd, ref p)) return false;
    x = p.x; y = p.y; w = r.r - r.l; h = r.b - r.t; return w > 200 && h > 200;
  }

  // Cherche les touches du clavier de Cemu (aplat 91,134,168, tolerance 3) : au moins quatre bandes horizontales bien remplies. Renvoie le centre de la zone trouvee, ou false.
  public static bool Detect(int x, int y, int w, int h, out int cx, out int cy) {
    cx = cy = 0;
    using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (Graphics gr = Graphics.FromImage(bmp)) gr.CopyFromScreen(x, y, 0, 0, new Size(w, h));
      BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        int step = 3, bands = 40; int[] hit = new int[bands], tot = new int[bands];
        int minX = int.MaxValue, maxX = -1, minY = int.MaxValue, maxY = -1;
        byte[] row = new byte[data.Stride];
        for (int j = 0; j < h; j += step) {
          Marshal.Copy(IntPtr.Add(data.Scan0, j * data.Stride), row, 0, data.Stride);
          int band = Math.Min(bands - 1, j * bands / h);
          for (int i = 0; i < w; i += step) {
            tot[band]++;
            int o = i * 4;
            if (Math.Abs(row[o + 2] - 91) <= 3 && Math.Abs(row[o + 1] - 134) <= 3 && Math.Abs(row[o] - 168) <= 3) {
              hit[band]++;
              if (i < minX) minX = i; if (i > maxX) maxX = i; if (j < minY) minY = j; if (j > maxY) maxY = j;
            }
          }
        }
        int full = 0; for (int k = 0; k < bands; k++) if (tot[k] > 0 && hit[k] * 100 > tot[k] * 12) full++;
        if (full < 4 || maxX < 0) return false;
        cx = x + (minX + maxX) / 2; cy = y + (minY + maxY) / 2; return true;
      } finally { bmp.UnlockBits(data); }
    }
  }

  // Etat des manettes : stick droit (-1..1, y vers le haut) et A, XInput puis Switch Pro ; le premier qui bouge ou appuie l'emporte.
  public static void Pad(out float px, out float py, out bool a) {
    px = 0; py = 0; a = false;
    for (int i = 0; i < 4; i++) {
      XS s;
      if (XInputGetState(i, out s) != 0) continue;
      float x = s.rx / 32767f, yv = s.ry / 32767f; bool pressed = (s.btn & 0x1000) != 0;
      if (Math.Abs(x) > Math.Abs(px) || Math.Abs(yv) > Math.Abs(py)) { px = x; py = yv; }
      if (pressed) a = true;
    }
    if (Math.Abs(proX) > Math.Abs(px) || Math.Abs(proY) > Math.Abs(py)) { px = proX; py = proY; }
    if (proA) a = true;
  }

  public static void Move(float px, float py, int width) {
    float dz = 0.2f;
    float vx = Math.Abs(px) < dz ? 0 : px, vy = Math.Abs(py) < dz ? 0 : py;
    if (vx == 0 && vy == 0) return;
    POINT p; GetCursorPos(out p);
    // Vitesse en pixels par image (80 images/s), courbe quadratique : precis au debut de la course du stick, rapide a fond.
    float speed = Math.Max(10f, width / 90f);
    int dx = (int)Math.Round(vx * Math.Abs(vx) * speed), dy = (int)Math.Round(-vy * Math.Abs(vy) * speed);
    SetCursorPos(p.x + dx, p.y + dy);
  }
  public static void Place(int x, int y) { SetCursorPos(x, y); }
  public static void Click(bool down) { mouse_event(down ? 0x0002u : 0x0004u, 0, 0, 0, UIntPtr.Zero); }
}
'@
$proc = $null
$active = $false; $wasA = $false; $lastCheck = 0; $lastScan = 0
$clock = [Diagnostics.Stopwatch]::StartNew()
while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Process -Id $CemuPid -ErrorAction SilentlyContinue)) {
  $now = $clock.ElapsedMilliseconds
  if ($now - $lastScan -gt 3000) { $lastScan = $now; try { [CK]::ScanPro() } catch {} }
  if ($now - $lastCheck -gt 500) {
    $lastCheck = $now
    try {
      $hwnd = (Get-Process -Id $CemuPid -ErrorAction Stop).MainWindowHandle
      $x = 0; $y = 0; $w = 0; $h = 0; $cx = 0; $cy = 0
      $found = $false
      if ([CK]::ClientBox($hwnd, [ref]$x, [ref]$y, [ref]$w, [ref]$h)) { $found = [CK]::Detect($x, $y, $w, $h, [ref]$cx, [ref]$cy) }
      if ($found -and -not $active) { $active = $true; [CK]::Place($cx, $cy); Write-Output 'KEYBOARD 1' }
      elseif (-not $found -and $active) { $active = $false; if ($wasA) { [CK]::Click($false); $wasA = $false }; Write-Output 'KEYBOARD 0' }
      $width = $w
    } catch {}
  }
  if ($active) {
    $px = [single]0; $py = [single]0; $a = $false
    [CK]::Pad([ref]$px, [ref]$py, [ref]$a)
    [CK]::Move($px, $py, $width)
    if ($a -and -not $wasA) { [CK]::Click($true) } elseif (-not $a -and $wasA) { [CK]::Click($false) }
    $wasA = $a
    Start-Sleep -Milliseconds 12
  } else { Start-Sleep -Milliseconds 60 }
}
`

/**
 * Lance la souris-manette du clavier à l'écran de Cemu pour le processus `cemuPid` ; renvoie la fonction d'arrêt. S'arrête aussi toute seule quand Kartouche ou Cemu se ferme.
 */
export async function startCemuKeyboardMouse(cacheDir: string, cemuPid: number): Promise<() => void> {
  const file = await scriptFile(cacheDir, 'cemu-keyboard.ps1', '﻿' + SCRIPT)
  const child = spawn('powershell.exe', [...PS_ARGS, file, '-ParentPid', String(process.pid), '-CemuPid', String(cemuPid)], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
  child.on('error', () => {})
  return () => { child.kill() }
}

export const CEMU_KEYBOARD_SCRIPT = SCRIPT
