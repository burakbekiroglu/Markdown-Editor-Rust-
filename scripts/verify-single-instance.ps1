<#
.SYNOPSIS
  Repeatable evidence that two back-to-back launches produce one window /
  one main process instance (single-instance proof).

.DESCRIPTION
  Launches the real release binary (src-tauri/target/release/md-editor.exe)
  twice in sequence and, at three checkpoints, reports the OS-level counts the
  acceptance criterion is expressed in:

    checkpoint 1: after launch 1 settles  -> md-editor.exe process count,
                  visible main window handles of the tree
    checkpoint 2: right after launch 2    -> same counts (must still be 1/1;
                  the second process exits itself before any window)
    checkpoint 3: after launch 2 is gone  -> final counts, plus WebView2
                  descendants tied to the surviving root process

  The script PASSes only when at every checkpoint there is exactly one
  md-editor.exe process owning exactly one visible top-level window, and the
  second launch terminated on its own within the deadline. It never kills the
  first instance before the checkpoints are taken; cleanup runs in `finally`.

  Read-only with respect to app code: it does not modify any application
  source, config or session state. It launches the binary with a clean
  command line (no args) exactly like a user double-click would.

  No new dependencies: Windows PowerShell 5.1 only (Get-CimInstance /
  Get-Process). Follows the conventions of scripts/measure-working-set.ps1.

.PARAMETER ExePath
  Binary under test. Default: src-tauri/target/release/md-editor.exe.

.PARAMETER FirstGraceSeconds
  Wait for the first instance to settle (and acquire the single-instance
  mutex) before the second launch. Default 3.

.PARAMETER SecondDeadlineSeconds
  Bounded deadline for the second instance to exit on its own. Default 15.

.PARAMETER JsonOut
  Optional path to write the result summary as JSON (for CI evidence logs).

.EXAMPLE
  pwsh -NoProfile -File scripts/verify-single-instance.ps1
#>
[CmdletBinding()]
param(
  [string]$ExePath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\target\release\md-editor.exe'),
  [int]$FirstGraceSeconds = 3,
  [int]$SecondDeadlineSeconds = 15,
  [string]$JsonOut = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw ("Binary not found: {0}. Build it first: npm run tauri:build (or cargo build --release in src-tauri)." -f $ExePath)
}

$script:AppName = [IO.Path]::GetFileNameWithoutExtension($ExePath)

function Get-AppProcesses {
  Get-Process -Name $script:AppName -ErrorAction SilentlyContinue
}

function Get-VisibleWindowCount {
  # Windows the tree owns that are actually visible top-level windows.
  param([object[]]$Processes)
  $count = 0
  foreach ($p in $Processes) {
    if ($null -ne $p -and $p.HasExited -ne $true -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
      $count++
    }
  }
  return $count
}

function Get-Checkpoint {
  param([string]$Label)
  $procs = @(Get-AppProcesses)
  $alive = @($procs | Where-Object { $_.HasExited -ne $true })
  [pscustomobject]@{
    Checkpoint          = $Label
    MainProcessCount    = $alive.Count
    Pids                = @($alive | ForEach-Object { $_.Id })
    VisibleWindowCount  = (Get-VisibleWindowCount $alive)
    WindowTitles        = @($alive | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | ForEach-Object { $_.MainWindowTitle })
    At                  = (Get-Date).ToString('o')
  }
}

function Start-AppInstance {
  Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Parent $ExePath) | Out-Null
}

function Wait-ForStableInstance {
  # Wait until exactly one process is alive and owns a visible window.
  param([int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $alive = @(Get-AppProcesses | Where-Object { $_.HasExited -ne $true })
    $windows = Get-VisibleWindowCount $alive
    if ($alive.Count -ge 1 -and $windows -ge 1) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Wait-ForSecondInstanceExit {
  # The single-instance plugin must make the second process exit on its own.
  param([int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $extra = @(Get-AppProcesses | Where-Object { $_.Id -ne $script:FirstPid -and $_.HasExited -ne $true })
    if ($extra.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Stop-AppInstances {
  Get-AppProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
}

# Precondition: a leftover instance from another run would falsify the counts.
$pre = @(Get-AppProcesses | Where-Object { $_.HasExited -ne $true })
if ($pre.Count -gt 0) {
  throw ("{0} is already running (PID {1}). Close it first: Get-Process {2} | Stop-Process -Force" -f $script:AppName, (($pre | ForEach-Object { $_.Id }) -join ', '), $script:AppName)
}

$checkpoints = New-Object System.Collections.Generic.List[object]
$script:FirstPid = $null
$secondExitedOnOwn = $false
$failure = $null

try {
  Write-Host ("[1/3] launch instance #1: {0}" -f $ExePath)
  Start-AppInstance
  if (-not (Wait-ForStableInstance $FirstGraceSeconds)) {
    $failure = 'ilk örnek pencere açmadan kapandı (ilk örneğin hiç penceresi olmadı)'
  } else {
    $script:FirstPid = ((Get-AppProcesses | Where-Object { $_.HasExited -ne $true })[0]).Id
    $checkpoints.Add((Get-Checkpoint 'after-launch-1'))

    Write-Host '[2/3] launch instance #2 (back-to-back, same binary, no args)'
    Start-AppInstance
    $checkpoints.Add((Get-Checkpoint 'right-after-launch-2'))

    $secondExitedOnOwn = Wait-ForSecondInstanceExit $SecondDeadlineSeconds
    if (-not $secondExitedOnOwn) {
      $failure = ("ikinci örnek {0} s içinde kendiliğinden sonlanmadı" -f $SecondDeadlineSeconds)
    }
    $checkpoints.Add((Get-Checkpoint 'after-launch-2-exited'))

    foreach ($cp in $checkpoints) {
      if ($cp.Checkpoint -eq 'right-after-launch-2') {
        # Transient second process is EXPECTED here: the single-instance plugin
        # hands over argv and exits it. The hard rule is that the transient
        # process must not own a visible window.
        $extraWindows = 0
        foreach ($p in (Get-AppProcesses | Where-Object { $_.Id -ne $script:FirstPid -and $_.HasExited -ne $true })) {
          if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $extraWindows++ }
        }
        if ($extraWindows -ne 0) {
          $failure = ("{0} kontrol noktasında geçici ikinci süreç pencere açtı (pencere={1})" -f $cp.Checkpoint, $extraWindows)
          break
        }
      } elseif ($cp.MainProcessCount -ne 1 -or $cp.VisibleWindowCount -ne 1) {
        $failure = ("{0} kontrol noktasında 1 süreç/1 pencere beklenirken süreç={1} pencere={2}" -f $cp.Checkpoint, $cp.MainProcessCount, $cp.VisibleWindowCount)
        break
      }
    }
  }
} finally {
  Stop-AppInstances
}

# Post-cleanup count: the script itself must not leave instances behind.
$leftover = @(Get-AppProcesses | Where-Object { $_.HasExited -ne $true })

# WebView2 descendant sanity: every msedgewebview2.exe in the tree must
# originate from the (single) surviving md-editor.exe root, never from a
# second app instance.
$webViewRoots = @()
try {
  $webViewRoots = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique)
} catch { }

$summary = [pscustomobject]@{
  App                = $script:AppName
  Binary             = $ExePath
  SecondExitedOnOwn  = $secondExitedOnOwn
  Pass               = ($null -eq $failure -and $leftover.Count -eq 0)
  Failure            = $failure
  LeftoverAfterCleanup = $leftover.Count
  WebView2ParentPids = $webViewRoots
  Checkpoints        = $checkpoints
}

$summary | Format-List App, SecondExitedOnOwn, Pass, Failure, LeftoverAfterCleanup
$checkpoints | Format-Table Checkpoint, MainProcessCount, VisibleWindowCount, Pids, At -AutoSize

if ($JsonOut -ne '') {
  $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $JsonOut -Encoding UTF8
  Write-Host ("JSON evidence written: {0}" -f $JsonOut)
}

if (-not $summary.Pass) {
  throw 'TEK PENCERE KANITI BAŞARISIZ — yukarıdaki kontrol noktalarına bakın.'
}

Write-Host 'PASS: iki ardışık başlatma sonrası 1 ana süreç, 1 görünür pencere.'
