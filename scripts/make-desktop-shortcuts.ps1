<#
.SYNOPSIS
  Create Windows desktop shortcuts that toggle Kasa outlets (or single switches),
  named for the action pressing them will take next (e.g. "Turn Fan On" / "Turn Fan Off").

.DESCRIPTION
  Each shortcut launches dist/kasa-toggle.mjs via a hidden VBS wrapper (no console
  flash) using the system Node at "C:\Program Files\nodejs\node.exe", passing the
  target host (and outlet name, for strip outlets) as arguments — so one wrapper
  script can drive any number of switches on any number of hosts. Run
  `npm run build:toggle` first so the bundle exists.

  Shortcut filenames reflect the action a click will perform next, and are kept
  in sync by kasa-toggle.mjs itself (it renames its own shortcut, and updates its
  hover-tooltip Description to match, after every toggle — see
  renameShortcutForNextAction in scripts/toggle.ts). This script queries each
  switch's *current* state up front to pick the right name/description, and
  writes dist/desktop-shortcuts.json so the CLI can find (and update) the right
  file later. Re-running this script deletes each switch's previous shortcut
  file before creating its (possibly differently-named) replacement.

  Note: this only keeps the *desktop* icon's name/tooltip live. A copy pinned to
  the Windows taskbar is a separate, frozen snapshot Windows makes at pin time —
  its label/tooltip will never update, by design of the Windows shell, no matter
  what this script or the CLI does.

.PARAMETER Switches
  Array of hashtables, one per physical switch:
    @{ Host = '192.168.1.42'; Outlets = @('Outlet 1', 'Outlet 2', 'Outlet 3') }  # a strip
    @{ Host = '192.168.1.43'; Name = 'Fan' }                                    # a single switch
  Defaults to a single example strip when omitted — edit the default below (or
  pass -Switches) to match your own setup.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\make-desktop-shortcuts.ps1

.EXAMPLE
  # Two switches on different hosts:
  ... -Switches @(
    @{ Host = '192.168.1.42'; Outlets = @('Outlet 1', 'Outlet 2', 'Outlet 3') },
    @{ Host = '192.168.1.43'; Name = 'Fan' }
  )
#>
param(
  [hashtable[]]$Switches = @(
    @{ Host = '192.168.1.42'; Outlets = @('Outlet 1', 'Outlet 2', 'Outlet 3') }
  )
)

$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $proj 'scripts\launchers\toggle-hidden.vbs'
$ico = Join-Path $proj 'dist\kasa-toggle.ico'
$bundle = Join-Path $proj 'dist\kasa-toggle.mjs'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$manifestPath = Join-Path $proj 'dist\desktop-shortcuts.json'

if (-not (Test-Path $bundle)) { throw "Bundle missing: $bundle  (run: npm run build:toggle)" }

# Load any existing manifest so a switch's *previous* shortcut file (which may
# have a different name, since names encode on/off state) can be removed
# before its replacement is created.
$previous = @{}
if (Test-Path $manifestPath) {
  $existing = Get-Content $manifestPath -Raw | ConvertFrom-Json
  foreach ($prop in $existing.PSObject.Properties) {
    $previous[$prop.Name] = $prop.Value
  }
}

$shell = New-Object -ComObject WScript.Shell
$manifest = @{}

foreach ($switch in $Switches) {
  $switchHost = $switch.Host
  if (-not $switchHost) { throw "Each entry in -Switches needs a Host." }
  if (-not $switch.Outlets -and -not $switch.Name) {
    throw "Switch '$switchHost' needs either Outlets (a strip) or a Name (a single switch)."
  }

  $targets = if ($switch.Outlets) {
    $switch.Outlets | ForEach-Object { @{ Label = $_; Outlet = $_ } }
  } else {
    , @{ Label = $switch.Name; Outlet = $null }
  }

  foreach ($t in $targets) {
    $label = $t.Label
    $key = if ($t.Outlet) { "$switchHost#$($t.Outlet.ToLowerInvariant())" } else { $switchHost }

    $cliArgs = @('--host', $switchHost, '--dry-run', '--json')
    if ($t.Outlet) { $cliArgs += @('--outlet', $t.Outlet) }
    try {
      $statusJson = & $nodeExe $bundle @cliArgs
      if ($LASTEXITCODE -ne 0) { throw "kasa-toggle exited with code $LASTEXITCODE" }
      $status = $statusJson | ConvertFrom-Json
    } catch {
      Write-Warning "Could not read current state for '$label' on $switchHost ($_); defaulting shortcut name to '$label On'."
      $status = [PSCustomObject]@{ on = $false }
    }

    $nextAction = if ($status.on) { 'Off' } else { 'On' }
    $lnk = Join-Path $desktop ("Turn {0} {1}.lnk" -f $label, $nextAction)
    $stateWord = if ($status.on) { 'ON' } else { 'OFF' }
    $description = "$label is $stateWord - click to turn $($nextAction.ToLowerInvariant())."

    if ($previous.ContainsKey($key) -and $previous[$key].lnkPath -ne $lnk -and (Test-Path $previous[$key].lnkPath)) {
      Remove-Item $previous[$key].lnkPath -Force
    }

    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = $wscript
    $sc.Arguments = if ($t.Outlet) { '"{0}" "{1}" "{2}"' -f $vbs, $switchHost, $t.Outlet } else { '"{0}" "{1}"' -f $vbs, $switchHost }
    $sc.WorkingDirectory = $proj
    $sc.IconLocation = "$ico,0"
    $sc.Description = $description
    $sc.WindowStyle = 7
    $sc.Save()

    $manifest[$key] = @{ label = $label; lnkPath = $lnk }
    Write-Output "created: $lnk"
  }
}

# `Set-Content -Encoding utf8` always writes a BOM in Windows PowerShell 5.1
# (there's no BOM-less UTF-8 option before PS 6), which Node's JSON.parse
# rejects outright — write via .NET directly to get plain UTF-8 instead.
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
