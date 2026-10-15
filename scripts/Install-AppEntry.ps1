param()
$ErrorActionPreference = 'Stop'
$hubRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'Portable-Paths.ps1')
$hubLaunch = Get-HubPortableTools -Root $hubRoot
$appDirectory = Join-Path $hubRoot 'data\app'
$iconFile = Join-Path $appDirectory 'hub.ico'
$entryName = 'AutoDL' + [char]0x7814 + [char]0x7A76 + [char]0x53F0 + '.lnk'
$entryFiles = @((Join-Path $hubRoot $entryName))
$launchVbs = Join-Path $PSScriptRoot 'Launch-App.vbs'
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscriptExe -PathType Leaf) -or -not (Test-Path -LiteralPath $launchVbs -PathType Leaf)) {
    throw 'The Windows script host or Research Hub launcher is missing.'
}
& $hubLaunch.nodeExe -e 'const c=require(process.argv[1]); for (const p of process.argv.slice(3)) c.assertEPath(p,{within:process.argv[2]});' (Join-Path $hubRoot 'src\core.js') $hubRoot $appDirectory $iconFile
if ($LASTEXITCODE -ne 0) { throw 'The icon path must resolve inside the portable folder.' }
foreach ($entryFile in $entryFiles) { Assert-HubManagedPath -Root $hubRoot -Path $entryFile | Out-Null }
[IO.Directory]::CreateDirectory($appDirectory) | Out-Null

# Draw the SVG design with built-in GDI+. No package installation or compiler.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap(256, 256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$rounded = New-Object Drawing.Drawing2D.GraphicsPath
$background = New-Object Drawing.Drawing2D.LinearGradientBrush([Drawing.Point]::new(8,8), [Drawing.Point]::new(248,248), [Drawing.ColorTranslator]::FromHtml('#14263b'), [Drawing.ColorTranslator]::FromHtml('#07121f'))
$fill = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#123e51'))
$nodeFill = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#9bf3dc'))
$outline = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#65dfcf'), 7)
$textPen = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#f4fbff'), 8)
$pngStream = New-Object IO.MemoryStream
try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([Drawing.Color]::Transparent)
    $rounded.AddArc(8,8,104,104,180,90)
    $rounded.AddArc(144,8,104,104,270,90)
    $rounded.AddArc(144,144,104,104,0,90)
    $rounded.AddArc(8,144,104,104,90,90)
    $rounded.CloseFigure()
    $graphics.FillPath($background, $rounded)
    $hexagon = [Drawing.PointF[]]@([Drawing.PointF]::new(128,73), [Drawing.PointF]::new(177,101), [Drawing.PointF]::new(177,156), [Drawing.PointF]::new(128,184), [Drawing.PointF]::new(79,156), [Drawing.PointF]::new(79,101))
    $outline.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
    $outline.StartCap = $outline.EndCap = [Drawing.Drawing2D.LineCap]::Round
    $textPen.StartCap = $textPen.EndCap = [Drawing.Drawing2D.LineCap]::Round
    $textPen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
    $graphics.FillPolygon($fill, $hexagon)
    $graphics.DrawPolygon($outline, $hexagon)
    $graphics.DrawLines($textPen, [Drawing.PointF[]]@([Drawing.PointF]::new(96,116), [Drawing.PointF]::new(113,130), [Drawing.PointF]::new(96,144)))
    $graphics.DrawLine($textPen, 125,145,154,145)
    $graphics.DrawLine($outline, 128,73,128,48)
    $graphics.DrawLine($outline, 177,156,200,169)
    $graphics.DrawLine($outline, 79,156,56,169)
    $graphics.FillEllipse($nodeFill, 118,33,20,20)
    $graphics.FillEllipse($nodeFill, 195,162,20,20)
    $graphics.FillEllipse($nodeFill, 41,162,20,20)
    $bitmap.Save($pngStream, [Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $pngStream.ToArray()
    $iconStream = [IO.File]::Open($iconFile, [IO.FileMode]::Create, [IO.FileAccess]::Write)
    $iconWriter = New-Object IO.BinaryWriter($iconStream)
    try {
        # ICONDIR plus one 256px PNG entry, supported by current Windows.
        $iconWriter.Write([uint16]0); $iconWriter.Write([uint16]1); $iconWriter.Write([uint16]1)
        $iconWriter.Write([byte]0); $iconWriter.Write([byte]0); $iconWriter.Write([byte]0); $iconWriter.Write([byte]0)
        $iconWriter.Write([uint16]1); $iconWriter.Write([uint16]32)
        $iconWriter.Write([uint32]$pngBytes.Length); $iconWriter.Write([uint32]22)
        $iconWriter.Write($pngBytes)
    } finally { $iconWriter.Dispose(); $iconStream.Dispose() }
} finally {
    $pngStream.Dispose(); $textPen.Dispose(); $outline.Dispose(); $nodeFill.Dispose()
    $fill.Dispose(); $background.Dispose(); $rounded.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}

$shortcutShell = New-Object -ComObject WScript.Shell
try {
    foreach ($entryFile in $entryFiles) {
        $shortcut = $shortcutShell.CreateShortcut($entryFile)
        if ((Test-Path -LiteralPath $entryFile) -and $shortcut.TargetPath -and
            $shortcut.Description -ne 'AutoDL Research Hub - guided workspace and Codex' -and
            $shortcut.Arguments.IndexOf($launchVbs, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw ('An unrelated app entry already exists: ' + $entryFile)
        }
        $shortcut.TargetPath = $wscriptExe
        $shortcut.Arguments = '//NoLogo "' + $launchVbs + '"'
        $shortcut.WorkingDirectory = $hubRoot
        $shortcut.WindowStyle = 1
        $shortcut.IconLocation = $iconFile + ',0'
        $shortcut.Description = 'AutoDL Research Hub - guided workspace and Codex'
        $shortcut.Save()
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
        Write-Output ('AppEntry: ' + $entryFile)
    }
} finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcutShell) | Out-Null }
Write-Output ('AppIcon: ' + $iconFile)
