<#
.SYNOPSIS
  Reproducible 5-tab total working-set measurement for the release binary.

.DESCRIPTION
  Runs the real release binary (src-tauri/target/release/md-editor.exe) with a
  deterministic 5-document session, activates every tab in a fixed order, waits
  for the layout to settle, then samples the *total working set* of the process
  tree (md-editor.exe + its msedgewebview2.exe descendants) with
  Get-Process WorkingSet64. No new dependencies: Windows PowerShell 5.1 only
  (System.Net.WebSockets for the WebView2 CDP tab checks).

  Metric (as requested for this task):
    total working set = SUM of WorkingSet64 over the root process and every
    msedgewebview2.exe descendant, in MiB. Peak and mean of the sampling window
    are reported per run; the summary reports the overall peak and the mean of
    the per-run means.

  Note: raw WorkingSet sums count shared WebView2/Chromium DLL pages once per
  process. docs/PERFORMANCE.md explains why the budget gate uses the reduced
  (shared-page-divided) total instead. This script deliberately measures the
  raw sum asked for by the task; do not use it as the budget gate.

.PARAMETER Runs
  Number of measured runs (default 3). One additional warm-up run is always
  executed first and excluded from the summary.

.PARAMETER WarmupSeconds
  Seconds to wait after the last tab activation before sampling (default 10).

.PARAMETER SampleSeconds
  Sampling window length per run (default 3).

.PARAMETER SampleIntervalMs
  Interval between samples inside the window (default 250).

.PARAMETER DebugPort
  Local CDP port used only for tab verification/activation (default 9447; it
  does not collide with scripts/measure-perf.mjs, which uses 9337).

.EXAMPLE
  pwsh -NoProfile -File scripts/measure-working-set.ps1 -Runs 3
#>
[CmdletBinding()]
param(
  [int]$Runs = 3,
  [int]$WarmupSeconds = 10,
  [int]$SampleSeconds = 3,
  [int]$SampleIntervalMs = 250,
  [int]$DebugPort = 9447,
  [ValidateRange(1, 20)]
  [int]$Tabs = 5,
  [int]$WaitForExclusiveSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:ExePath = Join-Path $script:ProjectRoot 'src-tauri\target\release\md-editor.exe'
$script:Workspace = Join-Path $script:ProjectRoot '.temp_files\perf-ws5'
$script:ProfileDir = Join-Path $script:ProjectRoot ('.temp_files\perf-webview-ws5-' + $PID)
$script:ConfigDir = Join-Path $env:APPDATA 'com.mdeditor.app'
$script:SessionPath = Join-Path $script:ConfigDir 'session.json'
$script:SessionBackup = Join-Path $script:ProjectRoot ('.temp_files\session-backup-ws5-' + $PID + '.json')
$script:AppStderrPath = Join-Path $script:ProjectRoot ('.temp_files\app-stderr-ws5-' + $PID + '.log')
$script:SessionExisted = $false
$script:LaunchedPid = 0
$script:OldBrowserArgs = $null
$script:OldProfileEnv = $null

function Write-Step([string]$Message) {
  Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message) -ForegroundColor Cyan
}

# --- deterministic measurement document -------------------------------------
# ASCII only: the document is generated on Windows PowerShell 5.1, which reads
# BOM-less scripts as ANSI. ~45 sections => ~300 lines, text-heavy document, so
# editor buffers and preview HTML are actually populated (see PERFORMANCE.md).
$script:Paragraph =
  'Bu paragraf hafif bir markdown editorunde acilan tipik bir belgenin metin ' +
  'yogunlugunu taklit eder; satir kaydirma, sozdizimi agaci ve onizleme duzeni ' +
  'bu uzunlukta gercek maliyetlerini gosterir. Metin deterministiktir, boylece ' +
  'ayni kosullarda alinan olcumler karsilastirilabilir.'

function New-MeasurementDocument([int]$Index) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("# Belge $Index")
  for ($section = 1; $section -le 45; $section++) {
    [void]$sb.AppendLine()
    [void]$sb.AppendLine("## Bolum $section")
    [void]$sb.AppendLine()
    [void]$sb.AppendLine($script:Paragraph)
    [void]$sb.AppendLine()
    [void]$sb.AppendLine($script:Paragraph)
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('- madde bir')
    [void]$sb.AppendLine('- madde iki')
    [void]$sb.AppendLine('- madde uc')
    [void]$sb.AppendLine('- madde dort')
    if ($section % 4 -eq 0) {
      [void]$sb.AppendLine()
      [void]$sb.AppendLine('| Alan | Deger |')
      [void]$sb.AppendLine('| --- | --- |')
      [void]$sb.AppendLine("| belge | $Index |")
      [void]$sb.AppendLine("| bolum | $section |")
    }
    if ($section % 4 -eq 2) {
      [void]$sb.AppendLine()
      [void]$sb.AppendLine('```js')
      [void]$sb.AppendLine("const deger$section = $($Index * $section);")
      [void]$sb.AppendLine('```')
    }
  }
  return $sb.ToString()
}

function Initialize-Workspace {
  if (Test-Path -LiteralPath $script:Workspace) {
    Remove-Item -LiteralPath $script:Workspace -Recurse -Force
  }
  $null = New-Item -ItemType Directory -Path $script:Workspace -Force
  for ($index = 1; $index -le $Tabs; $index++) {
    $name = 'doc-{0:D2}.md' -f $index
    $path = Join-Path $script:Workspace $name
    [System.IO.File]::WriteAllText($path, (New-MeasurementDocument $index), (New-Object System.Text.UTF8Encoding($false)))
  }
  Write-Step ("workspace: {0} ({1} documents, {2:N1} KB each)" -f $script:Workspace, $Tabs, ((Get-Item (Join-Path $script:Workspace 'doc-01.md')).Length / 1KB))
}

# --- session file ------------------------------------------------------------
# tauri-plugin-store keeps the document as {"session": {...}} (src/lib/session/ipc.ts).
function Set-MeasurementSession {
  # Not `$tabs`: PowerShell variable names are case-insensitive and that would
  # overwrite the $Tabs parameter.
  $sessionTabList = @()
  for ($index = 1; $index -le $Tabs; $index++) {
    $sessionTabList += [ordered]@{
      path   = ('doc-{0:D2}.md' -f $index)
      cursor = $null
      scroll = $null
    }
  }
  $session = [ordered]@{
    version      = 1
    root         = $script:Workspace.Replace('\', '/')
    tabs         = $sessionTabList
    activePath   = $sessionTabList[0].path
    viewMode     = 'split'
    splitRatio   = 0.5
    sidebarWidth = 250
  }
  $document = [ordered]@{ session = $session }
  if (-not (Test-Path -LiteralPath $script:ConfigDir)) {
    $null = New-Item -ItemType Directory -Path $script:ConfigDir -Force
  }
  if (-not $script:SessionExisted -and (Test-Path -LiteralPath $script:SessionPath)) {
    Copy-Item -LiteralPath $script:SessionPath -Destination $script:SessionBackup -Force
    $script:SessionExisted = $true
  }
  $json = $document | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($script:SessionPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Restore-Session {
  if ($script:SessionExisted -and (Test-Path -LiteralPath $script:SessionBackup)) {
    Copy-Item -LiteralPath $script:SessionBackup -Destination $script:SessionPath -Force
    Remove-Item -LiteralPath $script:SessionBackup -Force -ErrorAction SilentlyContinue
  }
}

# --- process tree ------------------------------------------------------------
function Get-DescendantIds([int]$RootPid) {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='md-editor.exe' OR Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue)
  $known = @{}
  $known[$RootPid] = $true
  $added = $true
  while ($added) {
    $added = $false
    foreach ($process in $all) {
      $processId = [int]$process.ProcessId
      $parentId = [int]$process.ParentProcessId
      if ($known.ContainsKey($parentId) -and -not $known.ContainsKey($processId)) {
        $known[$processId] = $true
        $added = $true
      }
    }
  }
  return @($known.Keys)
}

function Stop-MeasurementProcesses {
  if ($script:LaunchedPid -gt 0) {
    $ids = Get-DescendantIds -RootPid $script:LaunchedPid
    foreach ($processId in ($ids | Sort-Object -Descending)) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    $script:LaunchedPid = 0
  }
  # Fallback for a webview whose root already exited: match the profile path
  # this script owns, so no other WebView2 host is touched.
  $orphans = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script:ProfileDir) })
  foreach ($orphan in $orphans) {
    Stop-Process -Id $orphan.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-TreeSample([int]$RootPid) {
  $ids = Get-DescendantIds -RootPid $RootPid
  $processes = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
  $total = 0.0
  $main = 0.0
  $webview = 0.0
  $webviewCount = 0
  foreach ($process in $processes) {
    $bytes = [double]$process.WorkingSet64
    $total += $bytes
    if ($process.ProcessName -eq 'md-editor') {
      $main += $bytes
    } else {
      $webview += $bytes
      $webviewCount += 1
    }
  }
  return [pscustomobject]@{
    TotalMiB     = [math]::Round($total / 1MB, 1)
    MainMiB      = [math]::Round($main / 1MB, 1)
    WebViewMiB   = [math]::Round($webview / 1MB, 1)
    ProcessCount = $processes.Count
    WebViewCount = $webviewCount
  }
}

# --- condition-based bounded waits --------------------------------------------
# Koşul-tabanlı, kesin süreli bekleme. Tüm ölçüm beklemeleri (CDP sayfa hedefi,
# sekme sayısı, sekme arabelleği, tek örnek kilidi) bu tek yardımcıyı kullanır:
# koşul scriptblock'u truthy bir değer döndürdüğünde bekler, süre dolunca
# anlamlı hata verir; sınırsız yoklama kalmaz.
function Wait-Condition {
  param(
    [string]$Label,
    [int]$TimeoutSec,
    [int]$IntervalMs = 100,
    [Parameter(Mandatory)][scriptblock]$Condition
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $last = & $Condition
    if ($null -ne $last) { return $last }
    Start-Sleep -Milliseconds $IntervalMs
  }
  throw ("{0}: koşul {1} s içinde sağlanmadı (son değer: {2})." -f $Label, $TimeoutSec, $last)
}

# --- CDP over WebSockets (tab verification + activation) ---------------------
function Get-CdpPageTarget([int]$Port, $Process) {
  Wait-Condition -Label 'CDP page target' -TimeoutSec 30 -IntervalMs 100 -Condition {
    if ($null -ne $Process -and $Process.HasExited) {
      throw ("md-editor.exe exited before exposing a CDP page (exit code {0}). Another instance may already be running: the app uses tauri-plugin-single-instance, so a second launch quits silently." -f $Process.ExitCode)
    }
    try {
      $targets = @(Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/json/list" -f $Port) -TimeoutSec 2)
      $targets | Where-Object {
        $_.type -eq 'page' -and $_.webSocketDebuggerUrl -and ([string]$_.url) -like '*tauri.localhost*'
      } | Select-Object -First 1
    } catch {
      # WebView2 not up yet.
      $null
    }
  }
}

function Connect-Cdp([string]$Url) {
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  $socket.ConnectAsync([Uri]$Url, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
  return $socket
}

function Invoke-CdpEval($Socket, [string]$Expression) {
  $id = Get-Random -Minimum 1 -Maximum 1000000
  $payload = @{
    id     = $id
    method = 'Runtime.evaluate'
    params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
  } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $sendSegment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $bytes)
  $Socket.SendAsync($sendSegment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null

  $buffer = New-Object byte[] 65536
  $builder = New-Object System.Text.StringBuilder
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $receiveSegment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(, $buffer)
    $receive = $Socket.ReceiveAsync($receiveSegment, [System.Threading.CancellationToken]::None).GetAwaiter().GetResult()
    if ($receive.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
      throw 'CDP socket closed while waiting for a response.'
    }
    [void]$builder.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $receive.Count))
    if (-not $receive.EndOfMessage) { continue }
    $text = $builder.ToString()
    [void]$builder.Clear()
    $message = $text | ConvertFrom-Json
    if ($message.id -ne $id) { continue }
    if ($message.PSObject.Properties.Name -contains 'error') {
      throw ('CDP error: ' + ($message.error | ConvertTo-Json -Depth 6 -Compress))
    }
    return $message.result.result.value
  }
  throw 'CDP response timed out.'
}

function Wait-ForTabs($Socket, [int]$Expected) {
  Wait-Condition -Label "tab count >= $Expected" -TimeoutSec 30 -IntervalMs 100 -Condition {
    $count = [int](Invoke-CdpEval $Socket "document.querySelectorAll('[data-tab-id]').length")
    if ($count -ge $Expected) { $count } else { $null }
  }
}

function Invoke-TabVisits($Socket, [int]$Expected) {
  $ids = @(Invoke-CdpEval $Socket "Array.from(document.querySelectorAll('[data-tab-id]')).map(function (el) { return el.getAttribute('data-tab-id'); })")
  if ($ids.Count -lt $Expected) {
    throw "Only $($ids.Count) tabs found for visiting (expected $Expected)."
  }
  $visited = 0
  foreach ($tabId in $ids[0..($Expected - 1)]) {
    $idJson = ConvertTo-Json -InputObject ([string]$tabId) -Compress
    $clicked = Invoke-CdpEval $Socket ("(function () { var el = document.querySelector('[data-tab-id=' + $idJson + ']'); if (el === null) { return false; } el.click(); return true; })()")
    if ($clicked -ne $true) { throw "Tab '$tabId' could not be activated." }

    $null = Wait-Condition -Label "tab '$tabId' editor/preview buffer" -TimeoutSec 20 -IntervalMs 100 -Condition {
      $state = Invoke-CdpEval $Socket "(function () { var pane = document.querySelector('.editor-pane'); var content = document.querySelector('.editor-pane .cm-content'); var preview = document.querySelector('.preview-pane'); return { active: pane === null ? null : pane.getAttribute('data-tab'), docChars: content === null ? 0 : content.textContent.length, previewHtml: preview === null ? 0 : preview.innerHTML.length }; })()"
      if ($state.active -eq $tabId -and [int]$state.docChars -gt 0 -and [int]$state.previewHtml -gt 0) { $state } else { $null }
    }
    # Preview is produced behind a 120 ms debounce; let highlighting settle too.
    Start-Sleep -Milliseconds 300
    $visited += 1
  }
  return $visited
}

# --- one measurement run -----------------------------------------------------
function Invoke-MeasurementRun([string]$Label, [bool]$VisitTabs) {
  Stop-MeasurementProcesses
  Start-Sleep -Milliseconds 800

  $script:OldBrowserArgs = [Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
  $script:OldProfileEnv = [Environment]::GetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER')
  # --remote-allow-origins=* is required by current WebView2 runtimes; without
  # it the app exits before loading the window (see docs/PERFORMANCE.md).
  [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', ("--remote-debugging-port={0} --remote-allow-origins=*" -f $DebugPort))
  [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', $script:ProfileDir)

  try {
    $launchTime = Get-Date
    # Several agents work on this checkout and the app is single-instance, so a
    # peer's running instance makes our launch exit with code 0. Retry the
    # launch a few times inside a short all-clear window before giving up.
    $socket = $null
    $process = $null
    for ($launchAttempt = 1; $launchAttempt -le 5 -and $null -eq $socket; $launchAttempt++) {
      $clearBy = (Get-Date).AddSeconds(10)
      while (@(Get-Process -Name 'md-editor' -ErrorAction SilentlyContinue).Count -gt 0 -and (Get-Date) -lt $clearBy) {
        Start-Sleep -Milliseconds 150
      }
      $process = Start-Process -FilePath $script:ExePath -PassThru -RedirectStandardError $script:AppStderrPath
      $script:LaunchedPid = $process.Id
      try {
        $target = Get-CdpPageTarget -Port $DebugPort -Process $process
        $socket = Connect-Cdp -Url ([string]$target.webSocketDebuggerUrl)
      } catch {
        $appStderr = ''
        if (Test-Path -LiteralPath $script:AppStderrPath) {
          $rawStderr = Get-Content -LiteralPath $script:AppStderrPath -Raw -ErrorAction SilentlyContinue
          if ($null -ne $rawStderr) { $appStderr = $rawStderr.Trim() }
        }
        Write-Step ("{0}: launch attempt {1}/5 failed: {2} | stack: {3} | app-stderr: {4}" -f $Label, $launchAttempt, $_.Exception.Message, $_.ScriptStackTrace, $appStderr)
        Stop-MeasurementProcesses
        Start-Sleep -Seconds 1
      }
    }
    if ($null -eq $socket) {
      throw ("{0}: could not start an exclusive md-editor.exe instance after 5 attempts (single-instance collision with a peer)." -f $Label)
    }
    try {
      $count = Wait-ForTabs -Socket $socket -Expected $Tabs
      $visited = 0
      if ($VisitTabs) { $visited = Invoke-TabVisits -Socket $socket -Expected $Tabs }
      Write-Step ("{0}: {1} tabs, {2} visited; warming up {3} s" -f $Label, $count, $visited, $WarmupSeconds)
      Start-Sleep -Seconds $WarmupSeconds

      $samples = New-Object System.Collections.Generic.List[double]
      $deadline = (Get-Date).AddSeconds($SampleSeconds)
      do {
        $sample = Get-TreeSample -RootPid $script:LaunchedPid
        $samples.Add($sample.TotalMiB)
        Start-Sleep -Milliseconds $SampleIntervalMs
      } while ((Get-Date) -lt $deadline)

      $peak = ($samples | Measure-Object -Maximum).Maximum
      $mean = [math]::Round(($samples | Measure-Object -Average).Average, 1)
      $last = Get-TreeSample -RootPid $script:LaunchedPid
      # A zero/incomplete tree means the app died during the sampling window
      # (single-instance collision or an external `Stop-Process md-editor`).
      # Reporting that as a baseline would be a false 0 MiB result.
      if ($last.ProcessCount -lt 2 -or $last.WebViewCount -lt 1) {
        throw ("{0}: sampled process tree is incomplete ({1} processes, {2} WebView2 children). The app exited during the sampling window, so this run is not a valid baseline." -f $Label, $last.ProcessCount, $last.WebViewCount)
      }
      return [pscustomobject]@{
        Run       = $Label
        Tabs      = $count
        Visited   = $visited
        Samples   = $samples.Count
        PeakMiB   = [math]::Round($peak, 1)
        MeanMiB   = $mean
        MainMiB   = $last.MainMiB
        WebViewMiB = $last.WebViewMiB
        Processes = $last.ProcessCount
        WebViews  = $last.WebViewCount
        LaunchMs  = [int]((Get-Date) - $launchTime).TotalMilliseconds
      }
    } finally {
      try { $socket.Dispose() } catch { }
    }
  } finally {
    Stop-MeasurementProcesses
    [Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', $script:OldBrowserArgs)
    [Environment]::SetEnvironmentVariable('WEBVIEW2_USER_DATA_FOLDER', $script:OldProfileEnv)
    Start-Sleep -Milliseconds 600
  }
}

# --- main --------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $script:ExePath)) {
  throw "Release binary not found: $script:ExePath. Build it first: cargo build --release --manifest-path src-tauri/Cargo.toml"
}
$exeInfo = Get-Item -LiteralPath $script:ExePath
$script:BinaryHash = (Get-FileHash -LiteralPath $script:ExePath -Algorithm SHA256).Hash
Write-Step ("binary: {0} ({1:N0} bytes, {2:yyyy-MM-dd HH:mm:ss}, sha256 {3})" -f $exeInfo.Name, $exeInfo.Length, $exeInfo.LastWriteTime, $script:BinaryHash)

# Precondition: the app bundles tauri-plugin-single-instance, so a second
# launch quits silently and no CDP page ever appears. Wait for a peer's or a
# leftover instance to disappear instead of killing somebody else's app.
function Wait-ForExclusiveApp {
  Wait-Condition -Label 'exclusive md-editor instance + no peer measurement runner' -TimeoutSec $WaitForExclusiveSeconds -IntervalMs 5000 -Condition {
    # A peer performance run drives the same single-instance app and kills it
    # between runs; starting in the middle of one means being killed mid-sample.
    $peerRunners = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and ($_.CommandLine -like '*measure-perf.mjs*' -or $_.CommandLine -like '*leak-check.mjs*' -or $_.CommandLine -like '*measure-budgets.mjs*') })
    $running = @(Get-Process -Name 'md-editor' -ErrorAction SilentlyContinue)
    if ($peerRunners.Count -eq 0 -and $running.Count -eq 0) { return $true }
    if ($running.Count -gt 0) {
      Write-Step ("waiting for the other md-editor.exe instance(s) to exit (PID {0})" -f (($running | ForEach-Object { $_.Id }) -join ', '))
    } else {
      Write-Step ("waiting for a peer measurement to finish (node PID {0})" -f (($peerRunners | ForEach-Object { $_.ProcessId }) -join ', '))
    }
    $null
  }
  $running = @(Get-Process -Name 'md-editor' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    throw ("Another md-editor.exe instance is still running (PID {0}) after {1} s. The app is single-instance, so a second launch exits without a window. Close it, or for a leftover from an interrupted run: Get-Process md-editor | Stop-Process -Force" -f (($running | ForEach-Object { $_.Id }) -join ', '), $WaitForExclusiveSeconds)
  }
}

# A peer measurement or a Windows hiccup can abort one run (the app is killed
# or the CDP socket drops). Retry that run a bounded number of times instead of
# throwing the whole session away; the retry is recorded in the log.
function Invoke-RunWithRetry([string]$Label, [int]$Attempts = 6) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      Set-MeasurementSession
      $null = Wait-ForExclusiveApp
      return Invoke-MeasurementRun -Label $Label -VisitTabs $true
    } catch {
      Write-Step ("{0}: attempt {1}/{2} failed: {3}" -f $Label, $attempt, $Attempts, $_.Exception.Message)
      Stop-MeasurementProcesses
      if ($attempt -lt $Attempts) { Start-Sleep -Seconds 5 }
      else { throw }
    }
  }
}

Wait-ForExclusiveApp

if (Test-Path -LiteralPath $script:ProfileDir) {
  Remove-Item -LiteralPath $script:ProfileDir -Recurse -Force
}

Initialize-Workspace
Set-MeasurementSession
$results = New-Object System.Collections.Generic.List[object]
try {
  # One discarded warm-up run keeps the WebView2 profile warm for every
  # measured run, so run-to-run differences are not cold-start differences.
  Write-Step 'warm-up run (discarded)'
  $warm = Invoke-RunWithRetry -Label 'warmup'
  Write-Step ("warm-up: {0} tabs, peak {1} MiB" -f $warm.Tabs, $warm.PeakMiB)

  for ($run = 1; $run -le $Runs; $run++) {
    Write-Step ("run {0}/{1}" -f $run, $Runs)
    $results.Add((Invoke-RunWithRetry -Label ("run-$run")))
  }
} finally {
  Stop-MeasurementProcesses
  Restore-Session
  if (Test-Path -LiteralPath $script:ProfileDir) {
    Remove-Item -LiteralPath $script:ProfileDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$results | Format-Table Run, Tabs, Visited, Samples, PeakMiB, MeanMiB, MainMiB, WebViewMiB, Processes, WebViews, LaunchMs -AutoSize

$peaks = @($results | ForEach-Object { $_.PeakMiB })
$means = @($results | ForEach-Object { $_.MeanMiB })
$summary = [pscustomobject]@{
  Runs            = $results.Count
  Metric          = 'SUM(WorkingSet64) over md-editor.exe + msedgewebview2.exe descendants'
  PeakMiB         = ($peaks | Measure-Object -Maximum).Maximum
  AverageOfMeansMiB = [math]::Round(($means | Measure-Object -Average).Average, 1)
  MinRunPeakMiB   = ($peaks | Measure-Object -Minimum).Minimum
  MaxRunPeakMiB   = ($peaks | Measure-Object -Maximum).Maximum
}
$summary | Format-List
