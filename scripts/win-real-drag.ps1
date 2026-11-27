# e2e helper: perform one real mouse press-move-release drag.
#
# Why needed: since 2026-11-27 the shelf drag uses webContents.startDrag (system drag),
# which only starts from a real mouse gesture. A CDP-synthesized dragstart calls it
# without a button held, which blocks forever and freezes the main process (and CDP).
#
# Usage: powershell -File win-real-drag.ps1 <startX> <startY> <endX> <endY> [steps] [stepMs]
# Coordinates are physical screen pixels (caller converts via screenX/screenY/devicePixelRatio).
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class IslandDrag {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@

[void][IslandDrag]::SetProcessDPIAware()

if ($args.Count -lt 4) {
  Write-Error 'usage: win-real-drag.ps1 startX startY endX endY [steps] [stepMs]'
  exit 2
}

$sx = [int]$args[0]
$sy = [int]$args[1]
$tx = [int]$args[2]
$ty = [int]$args[3]
$steps = if ($args.Count -ge 5) { [int]$args[4] } else { 20 }
$ms = if ($args.Count -ge 6) { [int]$args[5] } else { 50 }

[void][IslandDrag]::SetCursorPos($sx, $sy)
[IslandDrag]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero)  # left button down
Start-Sleep -Milliseconds 150                          # let the renderer start the system drag
for ($i = 1; $i -le $steps; $i++) {
  $x = [int]($sx + (($tx - $sx) * $i / $steps))
  $y = [int]($sy + (($ty - $sy) * $i / $steps))
  [void][IslandDrag]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds $ms
}
Start-Sleep -Milliseconds 200
[IslandDrag]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)  # left button up
'ok'
