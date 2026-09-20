param([string]$ProcessIds = '')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BenchCpuSets {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetSystemCpuSetInformation(IntPtr info, uint length, out uint needed, IntPtr process, uint flags);
}
'@
[uint32]$required = 0
[void][BenchCpuSets]::GetSystemCpuSetInformation([IntPtr]::Zero, 0, [ref]$required, [IntPtr]::Zero, 0)
$buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$required)
try {
  if (![BenchCpuSets]::GetSystemCpuSetInformation($buffer, $required, [ref]$required, [IntPtr]::Zero, 0)) { throw 'GetSystemCpuSetInformation failed' }
  $topology = @()
  for ($offset = 0; $offset -lt $required;) {
    $entry = [IntPtr]::Add($buffer, $offset)
    $size = [Runtime.InteropServices.Marshal]::ReadInt32($entry, 0)
    if ($size -lt 32) { throw 'Invalid CPU set record' }
    if ([Runtime.InteropServices.Marshal]::ReadInt32($entry, 4) -eq 0) {
      $topology += [pscustomobject]@{
        group = [Runtime.InteropServices.Marshal]::ReadInt16($entry, 12)
        logical = [Runtime.InteropServices.Marshal]::ReadByte($entry, 14)
        core = [Runtime.InteropServices.Marshal]::ReadByte($entry, 15)
        efficiency = [Runtime.InteropServices.Marshal]::ReadByte($entry, 18)
      }
    }
    $offset += $size
  }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
# The highest EfficiencyClass is the fastest class, per the Win32 CPU Set contract.
# https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-system_cpu_set_information
$fastest = ($topology | Measure-Object -Property efficiency -Maximum).Maximum
$selected = @($topology | Where-Object { $_.efficiency -eq $fastest })
if (!$selected.Count -or @($topology | Where-Object { $_.group -ne 0 -or $_.logical -ge 63 }).Count) {
  throw 'This affinity policy requires one processor group with fewer than 64 logical CPUs'
}
[long]$mask = 0
foreach ($cpu in $selected) { $mask = $mask -bor ([long]1 -shl $cpu.logical) }
$applied = @()
if ($ProcessIds) {
  if ($ProcessIds -notmatch '^\d+(,\d+)*$') { throw 'Invalid process IDs' }
  foreach ($processIdText in $ProcessIds.Split(',')) {
    $process = Get-Process -Id ([int]$processIdText) -ErrorAction SilentlyContinue
    if ($null -eq $process) { continue }
    if ($process.ProcessName -ne 'chrome') { throw 'Only benchmark Chrome processes may be constrained' }
    $process.ProcessorAffinity = [IntPtr]$mask
    if ($process.ProcessorAffinity.ToInt64() -ne $mask) { throw 'CPU affinity verification failed' }
    $applied += $process.Id
  }
}
[pscustomobject]@{ policy = 'performance-cores'; mask = $mask.ToString(); selected = @($selected.logical); topology = $topology; applied = $applied } | ConvertTo-Json -Depth 4 -Compress
