<#
.SYNOPSIS
  Install an app on EVERY phone plugged into this PC, in EVERY profile - from one phone that already has it.

.DESCRIPTION
  Run this on a farm PC (the one that runs the PhoneDesk agent with the phones on USB). It does, for
  each package:

    1. finds ONE phone that already has the app (any profile) - the "source",
    2. pulls the app's APK files off that phone (Play Store apps are several "split" APKs),
    3. on every other phone: `adb install-multiple -r`, which installs for ALL existing profiles at once,
    4. then checks each profile and runs `pm install-existing --user <id>` for any profile that was missed,
    5. prints a table of what happened.

  Nothing is downloaded from the internet, nothing needs a Google account on the target phones, and the
  copy carries the Play Store signature, so Play Store updates keep working afterwards.

  BEFORE RUNNING: install the app from the Play Store on any ONE phone (any profile is fine). If no
  phone has it, the script tells you so and skips that package.

  It uses the PhoneDesk agent's own adb.exe when it can find it. That matters: a different adb version
  would restart the adb server and kick every live phone stream for a few seconds. If the agent is not
  installed in the usual place, pass -Adb "C:\path\to\adb.exe" (same version the agent ships).

  Safe to re-run: phones/profiles that already have the app are skipped.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-app-everywhere.ps1
      ChatGPT + X (Twitter) on every phone and profile.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-app-everywhere.ps1 -Packages com.openai.chatgpt
      Just ChatGPT.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-app-everywhere.ps1 -Source 2A091FDH2004XX
      Force a particular phone (serial from `adb devices`) as the one to copy from.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-app-everywhere.ps1 -Only 2A091FDH2004XX,2B041FDH3001YY
      Only touch these phones (still copies from a phone that has the app).
#>
param(
  [string[]]$Packages = @('com.openai.chatgpt', 'com.twitter.android'),
  [string]$Source = '',
  [string[]]$Only = @(),
  [string]$Adb = ''
)

$ErrorActionPreference = 'Continue'
# "powershell -File x.ps1 -Packages a,b" hands a string[] ONE element "a,b" - split it ourselves.
$Packages = @($Packages | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$Only     = @($Only     | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

# ---------- find adb (prefer the agent's bundled copy, see .DESCRIPTION) ----------
function Find-Adb {
  param([string]$Hint)
  if ($Hint) { if (Test-Path $Hint) { return $Hint } else { throw "adb not found at $Hint" } }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\PhoneDesk\resources\adb\win\adb.exe'),
    (Join-Path $env:ProgramFiles 'PhoneDesk\resources\adb\win\adb.exe'),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $onPath = Get-Command adb -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw 'adb.exe not found. Install PhoneDesk on this PC or pass -Adb C:\path\to\adb.exe'
}
$ADB = Find-Adb $Adb
Write-Host "Using adb: $ADB" -ForegroundColor DarkGray

# One place that runs adb and returns stdout as a string; never throws on non-zero exit.
function Adb { param([string[]]$A)
  $out = & $ADB @A 2>&1 | ForEach-Object { "$_" }
  return ($out -join "`n").Trim()
}

# ---------- phones ----------
$devices = @()
foreach ($line in (Adb @('devices')) -split "\r?\n") {
  if ($line -match '^(\S+)\s+device$') { $devices += $Matches[1] }
}
if (-not $devices) { Write-Host 'No phones in "device" state. Check USB / authorisation.' -ForegroundColor Red; exit 1 }
$targets = if ($Only) { $devices | Where-Object { $Only -contains $_ } } else { $devices }
Write-Host ("{0} phone(s) connected, {1} selected." -f $devices.Count, @($targets).Count)
if (-not @($targets).Count) { Write-Host ('None of the -Only serials is connected. Serials seen: ' + ($devices -join ', ')) -ForegroundColor Red; exit 1 }

function Get-Users { param([string]$Serial)
  $ids = @()
  foreach ($l in (Adb @('-s', $Serial, 'shell', 'pm', 'list', 'users')) -split "\r?\n") {
    if ($l -match 'UserInfo\{(\d+):') { $ids += [int]$Matches[1] }
  }
  return $ids
}
function Test-Installed { param([string]$Serial, [int]$User, [string]$Pkg)
  $out = Adb @('-s', $Serial, 'shell', 'pm', 'list', 'packages', '--user', "$User", $Pkg)
  # pm substring-matches; require the exact package line.
  return (($out -split "\r?\n") | Where-Object { $_.Trim() -eq "package:$Pkg" }).Count -gt 0
}
function Test-InstalledAnywhere { param([string]$Serial, [string]$Pkg)
  # `pm path` answers for the app's code regardless of which profile has it enabled.
  $out = Adb @('-s', $Serial, 'shell', 'pm', 'path', $Pkg)
  return $out -match '^package:'
}

$tmpRoot = Join-Path $env:TEMP ("pd-apks-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $tmpRoot | Out-Null
$report = @()

foreach ($pkg in $Packages) {
  Write-Host ""
  Write-Host "=== $pkg ===" -ForegroundColor Cyan

  # ---- 1. source phone ----
  $src = $null
  if ($Source) {
    if (Test-InstalledAnywhere $Source $pkg) { $src = $Source }
    else { Write-Host "  -Source $Source does not have $pkg; looking for another phone that does." -ForegroundColor Yellow }
  }
  if (-not $src) {
    foreach ($d in $devices) { if (Test-InstalledAnywhere $d $pkg) { $src = $d; break } }
  }
  if (-not $src) {
    Write-Host "  No phone on this PC has $pkg. Install it from the Play Store on ANY one phone, then run this again." -ForegroundColor Red
    $report += [pscustomobject]@{ Package = $pkg; Phone = '(all)'; Result = 'SKIPPED - no source phone' }
    continue
  }
  Write-Host "  Copying from $src"

  # ---- 2. pull the APK set ----
  $dir = Join-Path $tmpRoot ($pkg -replace '[^A-Za-z0-9_.]', '_')
  New-Item -ItemType Directory -Force $dir | Out-Null
  $paths = @()
  foreach ($l in (Adb @('-s', $src, 'shell', 'pm', 'path', $pkg)) -split "\r?\n") {
    if ($l -match '^package:(.+)$') { $paths += $Matches[1].Trim() }
  }
  $apks = @()
  foreach ($p in $paths) {
    $name = [IO.Path]::GetFileName($p)
    $local = Join-Path $dir $name
    $null = Adb @('-s', $src, 'pull', $p, $local)
    if (Test-Path $local) { $apks += $local } else { Write-Host "  could not pull $p" -ForegroundColor Yellow }
  }
  if (-not $apks) {
    Write-Host "  Pulled nothing from $src - giving up on $pkg." -ForegroundColor Red
    $report += [pscustomobject]@{ Package = $pkg; Phone = $src; Result = 'FAILED - could not pull APKs' }
    continue
  }
  $mb = [math]::Round((($apks | Get-Item | Measure-Object Length -Sum).Sum / 1MB), 1)
  Write-Host ("  {0} APK file(s), {1} MB" -f $apks.Count, $mb)

  # ---- 3+4. every selected phone ----
  foreach ($d in $targets) {
    $users = Get-Users $d
    if (-not $users) { $report += [pscustomobject]@{ Package = $pkg; Phone = $d; Result = 'FAILED - could not list profiles' }; continue }

    $missing = @($users | Where-Object { -not (Test-Installed $d $_ $pkg) })
    if (-not $missing) {
      Write-Host ("  {0}: already on all {1} profile(s)" -f $d, $users.Count) -ForegroundColor DarkGray
      $report += [pscustomobject]@{ Package = $pkg; Phone = $d; Result = ("ok - already on {0}/{0}" -f $users.Count) }
      continue
    }

    $note = ''
    if (-not (Test-InstalledAnywhere $d $pkg)) {
      # Not on this phone at all: a full install. Without --user this installs for ALL profiles.
      Write-Host ("  {0}: installing ({1} MB over USB)..." -f $d, $mb)
      $out = Adb (@('-s', $d, 'install-multiple', '-r') + $apks)
      if ($out -notmatch 'Success') {
        $note = ($out -split "\r?\n")[-1]
        Write-Host "    install failed: $note" -ForegroundColor Red
        $report += [pscustomobject]@{ Package = $pkg; Phone = $d; Result = "FAILED - $note" }
        continue
      }
      $missing = @($users | Where-Object { -not (Test-Installed $d $_ $pkg) })
    }

    # Already on the phone (or just installed) but some profile lacks it: enable it there. No download.
    $fixed = 0; $errs = @()
    foreach ($u in $missing) {
      $out = Adb @('-s', $d, 'shell', 'pm', 'install-existing', '--user', "$u", $pkg)
      if ($out -match 'installed for user') { $fixed++ } else { $errs += "user ${u}: $out" }
    }
    $have = @($users | Where-Object { Test-Installed $d $_ $pkg }).Count
    $res = "ok - on $have/$($users.Count) profiles"
    if ($errs) { $res = "PARTIAL - on $have/$($users.Count); " + ($errs -join '; ') }
    $color = if ($errs) { 'Yellow' } else { 'Green' }
    Write-Host ("  {0}: {1}" -f $d, $res) -ForegroundColor $color
    $report += [pscustomobject]@{ Package = $pkg; Phone = $d; Result = $res }
  }
}

Write-Host ""
Write-Host "================ SUMMARY ================" -ForegroundColor Cyan
$report | Format-Table -AutoSize | Out-String | Write-Host
Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
$bad = @($report | Where-Object { $_.Result -notmatch '^ok' }).Count
if ($bad) { Write-Host "$bad row(s) need attention (see above)." -ForegroundColor Yellow } else { Write-Host 'All done.' -ForegroundColor Green }
