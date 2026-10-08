<#
.SYNOPSIS
  Hard offline guarantee for the pipipiPopopo installation (Windows Firewall).

.DESCRIPTION
  The app-level offline guard (launch.ps1 -Offline / "offlineMode": true in
  Personal\Config\service-config.json / PI_WEB_OFFLINE=1) blocks the agent's
  network paths inside the application: the server only fetches loopback URLs,
  shell children get a black-hole proxy environment, and browser_page is
  disabled. A process that ignores proxy environment variables (raw sockets)
  could still reach the network, so for a HARD guarantee this script adds
  Windows Firewall outbound-block rules for every executable the agent can
  spawn from this installation (node.exe, python.exe). Loopback traffic is
  unaffected by design: Windows Firewall does not filter loopback, so the UI,
  the llama.cpp router and the local API keep working.

  Run from an elevated PowerShell (administrator). This script is run BY THE
  USER on request; the AI assistant must not run it.

.USAGE
  .\offline-guard.ps1 -Enable    # add the outbound block rules
  .\offline-guard.ps1 -Disable   # remove them
  .\offline-guard.ps1 -Status    # list current rules
#>
param([switch]$Enable, [switch]$Disable, [switch]$Status)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$RulePrefix = 'pipipiPopopo offline guard'

function Get-GuardTargets {
    $targets = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @(
        (Join-Path $Root 'node\node.exe'),
        'C:\Program Files\nodejs\node.exe',
        (Join-Path $Root 'tools\python\python.exe'),
        (Join-Path $Root 'tools\python\Scripts\python.exe')
    )) {
        if (Test-Path -LiteralPath $candidate) { $targets.Add((Resolve-Path -LiteralPath $candidate).Path) }
    }
    return $targets | Select-Object -Unique
}

if (-not ($Enable -or $Disable -or $Status)) {
    Write-Host 'Specify -Enable, -Disable or -Status. Run as administrator for -Enable/-Disable.'
    exit 1
}

if ($Status) {
    $rules = @(Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue)
    if ($rules.Count -eq 0) { Write-Host 'Offline guard firewall rules: NOT installed.' }
    else { $rules | Select-Object DisplayName, Enabled, Action | Format-Table -AutoSize }
    exit 0
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator rights are required to change firewall rules. Start PowerShell as administrator.'
}

if ($Disable) {
    $rules = @(Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue)
    foreach ($rule in $rules) { Remove-NetFirewallRule -Name $rule.Name }
    Write-Host "Removed $($rules.Count) offline guard rule(s)."
    exit 0
}

$targets = Get-GuardTargets
if ($targets.Count -eq 0) { throw 'No node/python executables found for this installation.' }
foreach ($exe in $targets) {
    $name = "$RulePrefix - $(Split-Path $exe -Leaf) ($exe)"
    if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
        Write-Host "Already present: $name"
        continue
    }
    New-NetFirewallRule -DisplayName $name -Direction Outbound -Action Block -Program $exe -Profile Any | Out-Null
    Write-Host "Blocked outbound: $exe"
}
Write-Host 'Done. Loopback (127.0.0.1) keeps working; remove with -Disable when finished with sensitive work.'
