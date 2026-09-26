# Genere l'icone de RomVault (build/icon.ico + build/icon.png) : coffre-fort stylise (cadran) avec un triangle de lecture.
# Usage : powershell -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'build'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  $r = $s * 0.22
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($s - $d, 0, $d, $d, 270, 90)
  $path.AddArc($s - $d, $s - $d, $d, $d, 0, 90); $path.AddArc(0, $s - $d, $d, $d, 90, 90); $path.CloseFigure()
  $rect = New-Object System.Drawing.RectangleF 0, 0, $s, $s
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 88, 64, 200)), ([System.Drawing.Color]::FromArgb(255, 18, 14, 44)), 60
  $g.FillPath($bg, $path)
  $c = $s / 2
  $white = [System.Drawing.Color]::White
  # anneau exterieur + graduations du cadran
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 255, 255, 255)), ($s * 0.045)
  $ro = $s * 0.36
  $g.DrawEllipse($pen, $c - $ro, $c - $ro, 2 * $ro, 2 * $ro)
  $pen2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 255, 255, 255)), ($s * 0.025)
  $pen2.StartCap = 'Round'; $pen2.EndCap = 'Round'
  for ($i = 0; $i -lt 12; $i++) {
    $a = $i * [Math]::PI / 6
    $r1 = $s * 0.41; $r2 = $s * 0.455
    $g.DrawLine($pen2, $c + $r1 * [Math]::Cos($a), $c + $r1 * [Math]::Sin($a), $c + $r2 * [Math]::Cos($a), $c + $r2 * [Math]::Sin($a))
  }
  # triangle de lecture
  $t = $s * 0.17
  $pts = @(
    (New-Object System.Drawing.PointF ($c - $t * 0.55), ($c - $t)),
    (New-Object System.Drawing.PointF ($c - $t * 0.55), ($c + $t)),
    (New-Object System.Drawing.PointF ($c + $t * 1.05), $c))
  $g.FillPolygon((New-Object System.Drawing.SolidBrush $white), $pts)
  $g.Dispose()
  return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-Icon $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , @($s, $ms.ToArray())
  if ($s -eq 256) { $bmp.Save((Join-Path $out 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
}
# ICO avec images PNG
$fs = [System.IO.File]::Create((Join-Path $out 'icon.ico'))
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
  $s = $p[0]; $data = $p[1]
  $bw.Write([byte]($s % 256)); $bw.Write([byte]($s % 256)); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$data.Length); $bw.Write([uint32]$offset)
  $offset += $data.Length
}
foreach ($p in $pngs) { $bw.Write($p[1]) }
$bw.Close(); $fs.Close()
Write-Host "OK: $out\icon.ico, icon.png"
