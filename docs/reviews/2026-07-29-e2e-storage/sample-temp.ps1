# Temp-footprint sampler for the e2e storage lane baseline.
# Samples the temp root for playwright* dirs every ~10s until $StopFile exists.
# Each CSV row: timestamp, dir count, total bytes, C: free bytes, scan seconds.
# Hardened v2: every iteration wrapped in try/catch; failures append to $Log and
# the loop continues — v1 died silently ~70s into run A.
param(
  [Parameter(Mandatory)] [string] $OutCsv,
  [Parameter(Mandatory)] [string] $StopFile,
  [string] $Log = "$OutCsv.log"
)
$ErrorActionPreference = 'Continue'
$temp = "$env:LOCALAPPDATA\Temp"
"ts,dirs,bytes,cFreeBytes,scanSec" | Set-Content $OutCsv
"sampler start $(Get-Date -Format o) pid=$PID" | Add-Content $Log
while (-not (Test-Path $StopFile)) {
  $t0 = Get-Date
  try {
    $dirs = @(Get-ChildItem $temp -Directory -Filter 'playwright*' -ErrorAction SilentlyContinue)
    $bytes = [int64]0
    foreach ($d in $dirs) {
      try {
        $s = Get-ChildItem $d.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
          Measure-Object Length -Sum
        $bytes += [int64]($s.Sum ?? 0)
      } catch {
        "dirscan $($d.Name): $_" | Add-Content $Log
      }
    }
    $scan = ((Get-Date) - $t0).TotalSeconds
    $free = [int64](Get-PSDrive C).Free
    "$($t0.ToString('yyyy-MM-dd HH:mm:ss')),$($dirs.Count),$bytes,$free,$([math]::Round($scan,1))" |
      Add-Content $OutCsv
  } catch {
    "iter $(Get-Date -Format o): $($_ | Out-String)" | Add-Content $Log
  }
  try {
    $scan2 = ((Get-Date) - $t0).TotalSeconds
    Start-Sleep -Seconds ([int][math]::Max(1, [math]::Ceiling(10 - $scan2)))
  } catch {
    "sleep $(Get-Date -Format o): $($_ | Out-String)" | Add-Content $Log
    Start-Sleep -Seconds 10
  }
}
"sampler stop $(Get-Date -Format o)" | Add-Content $Log
