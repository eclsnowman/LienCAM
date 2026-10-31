param([int]$BrowserId, [int]$RecorderId, [string]$Output)
$ErrorActionPreference = 'Stop'
$cores = [Environment]::ProcessorCount
$previous = @{}
$clock = [Diagnostics.Stopwatch]::StartNew()
$last = $clock.Elapsed.TotalSeconds
$writer = [IO.StreamWriter]::new($Output, $false, [Text.Encoding]::ASCII)
$writer.AutoFlush = $true
$writer.WriteLine('elapsedSeconds,totalCpuPercent,browserCpuPercent,recorderCpuPercent,gpuUtilPercent,freeRamMiB,browserPids,recorderPid')
try {
  Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -Continuous | ForEach-Object {
    if (!(Get-Process -Id $RecorderId -ErrorAction SilentlyContinue)) { exit 0 }
    $now = $clock.Elapsed.TotalSeconds
    $tree = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'")
    $ids = @($BrowserId)
    do {
      $added = @($tree | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { [int]$_.ProcessId })
      $ids += $added
    } while ($added.Count)
    $browserCpu = 0.0
    $recorderCpu = 0.0
    foreach ($process in @(Get-Process -Id ($ids + $RecorderId) -ErrorAction SilentlyContinue)) {
      $cpu = $process.TotalProcessorTime.TotalSeconds
      if ($previous.ContainsKey($process.Id)) {
        $percent = 100 * ($cpu - $previous[$process.Id]) / ($now - $last) / $cores
        if ($process.Id -eq $RecorderId) { $recorderCpu += $percent } else { $browserCpu += $percent }
      }
      $previous[$process.Id] = $cpu
    }
    # Drain the native command before selecting: First 1 closes its pipe early
    # on Windows PowerShell 5.1 and turns a successful readback into exit -1.
    $gpuRows = @(& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits)
    if ($LASTEXITCODE -ne 0) { throw 'GPU load readback failed' }
    $gpu = $gpuRows[0].Trim()
    $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024
    # First CPU delta is unavailable, never label it as a measured zero.
    $b = if ($last -lt 0.1) { '' } else { $browserCpu.ToString('F3', [Globalization.CultureInfo]::InvariantCulture) }
    $r = if ($last -lt 0.1) { '' } else { $recorderCpu.ToString('F3', [Globalization.CultureInfo]::InvariantCulture) }
    $writer.WriteLine(('{0:F3},{1:F3},{2},{3},{4},{5:F1},{6},{7}' -f $now, $_.CounterSamples[0].CookedValue, $b, $r, $gpu, $free, ($ids -join ';'), $RecorderId))
    $last = $now
  }
} finally { $writer.Dispose() }
