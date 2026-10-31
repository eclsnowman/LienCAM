param([string]$Title)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class V02Window {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$window = Get-Process | Where-Object { $_.MainWindowTitle -like "$Title*" } | Select-Object -First 1
if (!$window) { throw "Capture window not found: $Title" }
[V02Window]::ShowWindow($window.MainWindowHandle, 9) | Out-Null
$topmost = [V02Window]::SetWindowPos($window.MainWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 0x43)
$foreground = [V02Window]::SetForegroundWindow($window.MainWindowHandle)
@{pid=$window.Id; handle=$window.MainWindowHandle.ToInt64(); topmost=$topmost; foreground=$foreground} | ConvertTo-Json -Compress
