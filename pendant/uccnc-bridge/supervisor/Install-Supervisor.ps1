# Installs the bridge supervisor (supervisor.mjs) beside liencam-bridge.exe and registers it as the current-user login task the app relies on (WO-1179). Called by tools/bridge-shortcut/New-BridgeShortcut.ps1; lives beside the supervisor it installs.
param([Parameter(Mandatory = $true)][string]$BridgeDirectoryPath, [Parameter(Mandatory = $true)][string]$BridgePath)
$ErrorActionPreference = 'Stop'

$supervisorSource = Join-Path $PSScriptRoot 'supervisor.mjs'
if (-not (Test-Path -LiteralPath $supervisorSource -PathType Leaf)) { throw "Bridge supervisor source was not found at $supervisorSource" }
$supervisorPath = Join-Path $bridgeDirectoryPath 'liencam-bridge-supervisor.mjs'
Copy-Item -LiteralPath $supervisorSource -Destination $supervisorPath -Force

$nodePath = (Get-Command node -ErrorAction Stop).Source
$taskName = 'LienCAM Bridge Supervisor'
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$supervisorArguments = '"' + $supervisorPath + '" --bridge "' + $bridgePath + '" --port 8325 --supervisor-port 8326'
$taskAction = New-ScheduledTaskAction -Execute $nodePath -Argument $supervisorArguments -WorkingDirectory $bridgeDirectoryPath
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask -and $existingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName
}
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output $supervisorPath
