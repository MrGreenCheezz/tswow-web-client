param(
  [string]$ProcessIds = '',
  [ValidateSet('fastest', 'slowest', 'none')][string]$Class = 'fastest',
  [ValidateSet('normal', 'abovenormal', 'high')][string]$Priority = 'abovenormal',
  [string]$ProcessName = 'electron'
)
# The desktop shell's CPU policy: the same topology rule as bench/cpu-policy.ps1 (the highest Win32
# CPU Set EfficiencyClass is the fastest class), applied to the shell's own processes only.
# Windows 10 has no Thread Director, so without this the renderer lands on efficiency cores; the
# city bench measured 13 ms/frame on performance cores and 22 ms on efficiency cores.
# Processes are opened by id and checked by ProcessName only; no module list is ever read.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopCpuSets {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetSystemCpuSetInformation(IntPtr info, uint length, out uint needed, IntPtr process, uint flags);
}
'@
[uint32]$required = 0
[void][DesktopCpuSets]::GetSystemCpuSetInformation([IntPtr]::Zero, 0, [ref]$required, [IntPtr]::Zero, 0)
$buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$required)
try {
  if (![DesktopCpuSets]::GetSystemCpuSetInformation($buffer, $required, [ref]$required, [IntPtr]::Zero, 0)) { throw 'GetSystemCpuSetInformation failed' }
  $topology = @()
  for ($offset = 0; $offset -lt $required;) {
    $entry = [IntPtr]::Add($buffer, $offset)
    $size = [Runtime.InteropServices.Marshal]::ReadInt32($entry, 0)
    if ($size -lt 32) { throw 'Invalid CPU set record' }
    if ([Runtime.InteropServices.Marshal]::ReadInt32($entry, 4) -eq 0) {
      $topology += [pscustomobject]@{
        group = [Runtime.InteropServices.Marshal]::ReadInt16($entry, 12)
        logical = [Runtime.InteropServices.Marshal]::ReadByte($entry, 14)
        efficiency = [Runtime.InteropServices.Marshal]::ReadByte($entry, 18)
      }
    }
    $offset += $size
  }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
if (@($topology | Where-Object { $_.group -ne 0 -or $_.logical -ge 63 }).Count) {
  throw 'This affinity policy requires one processor group with fewer than 64 logical CPUs'
}
[long]$mask = 0
$selected = @()
if ($Class -ne 'none') {
  $wanted = if ($Class -eq 'slowest') { ($topology | Measure-Object -Property efficiency -Minimum).Minimum }
    else { ($topology | Measure-Object -Property efficiency -Maximum).Maximum }
  $selected = @($topology | Where-Object { $_.efficiency -eq $wanted })
  foreach ($cpu in $selected) { $mask = $mask -bor ([long]1 -shl $cpu.logical) }
}
$priorityClass = switch ($Priority) {
  'high' { [Diagnostics.ProcessPriorityClass]::High }
  'abovenormal' { [Diagnostics.ProcessPriorityClass]::AboveNormal }
  default { [Diagnostics.ProcessPriorityClass]::Normal }
}
$applied = @()
if ($ProcessIds) {
  if ($ProcessIds -notmatch '^\d+(,\d+)*$') { throw 'Invalid process IDs' }
  foreach ($processIdText in $ProcessIds.Split(',')) {
    $process = Get-Process -Id ([int]$processIdText) -ErrorAction SilentlyContinue
    if ($null -eq $process) { continue }
    if ($process.ProcessName -ne $ProcessName) { throw "Only $ProcessName processes may be constrained" }
    if ($mask -ne 0) {
      $process.ProcessorAffinity = [IntPtr]$mask
      if ($process.ProcessorAffinity.ToInt64() -ne $mask) { throw 'CPU affinity verification failed' }
    }
    $process.PriorityClass = $priorityClass
    $applied += $process.Id
  }
}
[pscustomobject]@{
  policy = $(switch ($Class) { 'slowest' { 'efficiency-cores' } 'none' { 'system-default' } default { 'performance-cores' } })
  mask = $mask.ToString(); selected = @($selected.logical); priority = $Priority; applied = $applied
} | ConvertTo-Json -Depth 3 -Compress
