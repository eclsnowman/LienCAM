$ErrorActionPreference = 'Stop'
$base = '__BASE__'
try {
    Invoke-WebRequest -UseBasicParsing "$base/started" -Method Post -Body 'started' | Out-Null
    New-Item -ItemType Directory C:\Driver | Out-Null
    Invoke-WebRequest -UseBasicParsing "$base/guest.zip" -OutFile C:\guest.zip
    Expand-Archive -LiteralPath C:\guest.zip -DestinationPath C:\Driver
    $installer = @(Get-ChildItem C:\Installer -Filter '*-setup.exe')
    if ($installer.Count -ne 1) { throw 'Expected exactly one installer' }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $install = Start-Process -FilePath $installer[0].FullName -ArgumentList '/S' -PassThru -WindowStyle Hidden
    if (-not $install.WaitForExit(180000)) { throw 'Installer timed out' }
    if ($install.ExitCode -ne 0) { throw "Installer exit $($install.ExitCode)" }
    $app = Join-Path $env:LOCALAPPDATA 'Programs\LienCAM\LienCAM.exe'
    if (-not (Test-Path -LiteralPath $app)) { throw "No installed app at $app" }
    $env:STRANGER_INSTALL_MS = [string]$watch.ElapsedMilliseconds
    $env:PLAYWRIGHT_BROWSERS_PATH = 'C:\Driver\browsers'
    & C:\Driver\node.exe C:\Driver\guest.mjs $app $base
    if ($LASTEXITCODE -ne 0) { throw "Guest driver exit $LASTEXITCODE; see uploaded result" }
} catch {
    $failure = @{status='BLOCKED';reason=$_.Exception.Message} | ConvertTo-Json -Compress
    Invoke-WebRequest -UseBasicParsing "$base/result" -Method Post -Body $failure | Out-Null
} finally {
    # This only shuts down the disposable guest, never the host.
    shutdown.exe /s /t 5
}
