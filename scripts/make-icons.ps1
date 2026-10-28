# Generates icons/icon{16,32,48,128}.png: rounded tile with a white download arrow.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force $out | Out-Null

foreach ($size in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = $size / 128.0
  $r = 28 * $s
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
  $path.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $path.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $size, $size),
    [System.Drawing.Color]::FromArgb(255, 255, 94, 58), [System.Drawing.Color]::FromArgb(255, 214, 36, 110))
  $g.FillPath($brush, $path)

  $white = [System.Drawing.Brushes]::White
  # arrow shaft + head
  $g.FillRectangle($white, [single](54 * $s), [single](22 * $s), [single](20 * $s), [single](44 * $s))
  $head = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF (30 * $s), (60 * $s)),
    (New-Object System.Drawing.PointF (98 * $s), (60 * $s)),
    (New-Object System.Drawing.PointF (64 * $s), (94 * $s)))
  $g.FillPolygon($white, $head)
  # tray
  $g.FillRectangle($white, [single](28 * $s), [single](100 * $s), [single](72 * $s), [single](12 * $s))

  $bmp.Save((Join-Path $out "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
