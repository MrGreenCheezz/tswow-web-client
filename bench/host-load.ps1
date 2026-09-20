param([string]$ExcludeProcessIds = '', [int]$SampleMilliseconds = 2000)
$ErrorActionPreference = 'Stop'
if ($ExcludeProcessIds -and $ExcludeProcessIds -notmatch '^\d+(,\d+)*$') { throw 'Invalid process IDs' }
$excluded = @{}
$excluded[$PID] = $true
foreach ($idText in $ExcludeProcessIds.Split(',')) { if ($idText) { $excluded[[int]$idText] = $true } }
$previous = @{}
Get-Process | ForEach-Object { if (!$excluded.ContainsKey($_.Id) -and $null -ne $_.CPU) { $previous[$_.Id] = $_.CPU } }
$clock = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds $SampleMilliseconds
$elapsed = $clock.Elapsed.TotalSeconds
$active = @(Get-Process | Where-Object { !$excluded.ContainsKey($_.Id) -and $previous.ContainsKey($_.Id) -and $null -ne $_.CPU } | ForEach-Object {
  $delta = [math]::Max(0, $_.CPU - $previous[$_.Id])
  if ($delta -gt 0) { [pscustomobject]@{ name = $_.ProcessName; id = $_.Id; cpuCores = $delta / $elapsed } }
})
$total = ($active | Measure-Object -Property cpuCores -Sum).Sum
[pscustomobject]@{ elapsedSeconds = $elapsed; externalCpuCores = [double]$total; busiest = @($active | Sort-Object cpuCores -Descending | Select-Object -First 5) } | ConvertTo-Json -Depth 4 -Compress
