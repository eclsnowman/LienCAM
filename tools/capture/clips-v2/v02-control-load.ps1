param([int]$BrowserId, [int]$LifetimeId, [string]$Output, [string]$Ready, [string]$Stop)
$ErrorActionPreference = 'Stop'
$cores = [Environment]::ProcessorCount
$invariant = [Globalization.CultureInfo]::InvariantCulture
$cpuCounter = [Diagnostics.PerformanceCounter]::new('Processor', '% Processor Time', '_Total')
$ramCounter = [Diagnostics.PerformanceCounter]::new('Memory', 'Available MBytes')
$null = $cpuCounter.NextValue()
$tree = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'")
$ids = @($BrowserId)
do {
  $added = @($tree | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | ForEach-Object { [int]$_.ProcessId })
  $ids += $added
} while ($added.Count)
$previous = @{}
foreach ($process in @(Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $previous[$process.Id] = $process.TotalProcessorTime.TotalSeconds }
$clock = [Diagnostics.Stopwatch]::StartNew()
$last = 0.0
$writer = [IO.StreamWriter]::new($Output, $false, [Text.Encoding]::ASCII)
$writer.AutoFlush = $true
$writer.WriteLine('elapsedSeconds,wallTimeMs,totalCpuPercent,browserCpuPercent,gpuUtilPercent,freeRamMiB,sampleWorkMs,browserPids')
try {
  [IO.File]::WriteAllText($Ready, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString())
  $tick = 1
  while (!(Test-Path -LiteralPath $Stop) -and (Get-Process -Id $LifetimeId -ErrorAction SilentlyContinue)) {
    $remaining = $tick * 1000 - $clock.Elapsed.TotalMilliseconds
    if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int]$remaining) }
    $now = $clock.Elapsed.TotalSeconds
    $wall = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $cpu = $cpuCounter.NextValue()
    $free = $ramCounter.NextValue()
    $browserCpu = 0.0
    foreach ($process in @(Get-Process -Id $ids -ErrorAction SilentlyContinue)) {
      $value = $process.TotalProcessorTime.TotalSeconds
      if ($previous.ContainsKey($process.Id)) { $browserCpu += 100 * ($value - $previous[$process.Id]) / ($now - $last) / $cores }
      $previous[$process.Id] = $value
    }
    # Drain the native pipe. Never use Select-Object -First on nvidia-smi.
    $gpuRows = @(& nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits)
    if ($LASTEXITCODE -ne 0) { throw 'GPU load readback failed' }
    $gpu = [double]::Parse($gpuRows[0].Trim(), $invariant)
    $work = $clock.Elapsed.TotalMilliseconds - $now * 1000
    $writer.WriteLine([string]::Format($invariant, '{0:F3},{1},{2:F3},{3:F3},{4:F3},{5:F1},{6:F3},{7}', $now, $wall, $cpu, $browserCpu, $gpu, $free, $work, ($ids -join ';')))
    $last = $now
    $tick++
  }
} finally { $writer.Dispose(); $cpuCounter.Dispose(); $ramCounter.Dispose() }
