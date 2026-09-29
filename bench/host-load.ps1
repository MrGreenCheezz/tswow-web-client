param([string]$ExcludeProcessIds = '', [int]$SampleMilliseconds = 2000)
$ErrorActionPreference = 'Stop'
if ($ExcludeProcessIds -and $ExcludeProcessIds -notmatch '^\d+(,\d+)*$') { throw 'Invalid process IDs' }
$excluded = @{}
$excluded[$PID] = $true
foreach ($idText in $ExcludeProcessIds.Split(',')) { if ($idText) { $excluded[[int]$idText] = $true } }
$previous = @{}
$clock = [Diagnostics.Stopwatch]::StartNew()
Get-Process | ForEach-Object {
  if (!$excluded.ContainsKey($_.Id)) {
    $cpu = $_.CPU
    if ($null -ne $cpu) { $previous[$_.Id] = @{ cpu = $cpu; time = $clock.Elapsed.TotalSeconds } }
  }
}
Start-Sleep -Milliseconds $SampleMilliseconds
$active = @(Get-Process | ForEach-Object {
  if (!$excluded.ContainsKey($_.Id) -and $previous.ContainsKey($_.Id)) {
    $cpu = $_.CPU
    $time = $clock.Elapsed.TotalSeconds
    if ($null -ne $cpu) {
      $before = $previous[$_.Id]
      $delta = [math]::Max(0, $cpu - $before.cpu)
      $interval = $time - $before.time
      if ($delta -gt 0 -and $interval -gt 0) {
        [pscustomobject]@{ name = $_.ProcessName; id = $_.Id; cpuCores = $delta / $interval; intervalSeconds = $interval }
      }
    }
  }
})
$total = ($active | Measure-Object -Property cpuCores -Sum).Sum
[pscustomobject]@{ elapsedSeconds = $clock.Elapsed.TotalSeconds; externalCpuCores = [double]$total; busiest = @($active | Sort-Object cpuCores -Descending | Select-Object -First 5) } | ConvertTo-Json -Depth 4 -Compress
