<#
.SYNOPSIS
  Interactive status/stop console for the pipipiPopopo services.

.DESCRIPTION
  Shows, at a glance, whether the llama.cpp router and the Web UI are running
  (listener PID, process, uptime, health check) and lets you stop them
  manually: one service, or both, with a confirmation prompt. Stopping reuses
  the same safety rule as stop-services.ps1 — only process trees recorded by
  the launcher (logs\*-process.json) are killed, and only after verifying the
  PID still matches the recorded executable and start time.

  Double-click "Workfree Status.cmd" at the installation root to open it.
  -Once prints the status once and exits (non-interactive, for scripts/tests).
#>
param([switch]$Once)
. "$PSScriptRoot\workfree-env.ps1"
$Config = Get-Content -LiteralPath $ServiceConfigPath -Raw | ConvertFrom-Json

$Services = @(
    @{Key='model'; Name='Model router (llama.cpp)'; Port=$Config.modelPort; Endpoint='/health';     Record='llama-process.json'},
    @{Key='ui';    Name='Web UI';                   Port=$Config.uiPort;    Endpoint='/api/health'; Record='ui-process.json'}
)

function Get-ServiceStatus([hashtable]$Service) {
    $status = [ordered]@{
        Name   = $Service.Name
        Url    = "http://127.0.0.1:$($Service.Port)"
        Listening = $false
        Pid    = $null
        Process = $null
        StartedLocal = $null
        Healthy = $false
        Detail = ''
    }
    $listener = Get-NetTCPConnection -LocalPort $Service.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $status.Listening = $true
        $status.Pid = $listener.OwningProcess
        $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) {
            $status.Process = $proc.ProcessName
            try { $status.StartedLocal = $proc.StartTime.ToString('yyyy-MM-dd HH:mm:ss') } catch {}
        }
    }
    try {
        $body = Invoke-RestMethod ($status.Url + $Service.Endpoint) -TimeoutSec 3
        $status.Healthy = $true
        $status.Detail = ($body | ConvertTo-Json -Compress -Depth 4)
        if ($status.Detail.Length -gt 120) { $status.Detail = $status.Detail.Substring(0, 117) + '...' }
    } catch {
        $status.Detail = $_.Exception.Message
    }
    return [pscustomobject]$status
}

function Stop-RecordedService([hashtable]$Service) {
    $recordPath = "$Root\logs\$($Service.Record)"
    if (-not (Test-Path -LiteralPath $recordPath)) {
        Write-Host "  No launcher record ($($Service.Record)); cannot stop safely from here." -ForegroundColor Yellow
        Write-Host "  If something else occupies port $($Service.Port), close that program itself." -ForegroundColor Yellow
        return
    }
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $proc = Get-Process -Id $record.Pid -ErrorAction SilentlyContinue
    if (-not $proc) { Write-Host "  Not running (recorded PID $($record.Pid) is gone)."; return }
    if ($proc.Path -ne $record.Exe -or $proc.StartTime.ToUniversalTime() -ne ([datetime]$record.StartedUtc).ToUniversalTime()) {
        Write-Host "  PID $($record.Pid) no longer matches the recorded process; refusing to stop it." -ForegroundColor Red
        return
    }
    $confirm = Read-Host "  Stop '$($Service.Name)' (PID $($proc.Id), process tree)? [y/N]"
    if ($confirm -notin @('y', 'Y')) { Write-Host '  Skipped.'; return }
    & taskkill.exe /PID $proc.Id /T /F | Out-Null
    Start-Sleep -Milliseconds 500
    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
        Write-Host "  Could not stop PID $($proc.Id)." -ForegroundColor Red
    } else {
        Write-Host "  Stopped '$($Service.Name)' (PID $($proc.Id))." -ForegroundColor Green
    }
}

function Show-Status {
    Write-Host ''
    Write-Host '=== pipipiPopopo services ===' -ForegroundColor Cyan
    foreach ($svc in $Services) {
        $s = Get-ServiceStatus $svc
        $state = if ($s.Healthy) { 'RUNNING (healthy)' } elseif ($s.Listening) { 'LISTENING (health failed)' } else { 'STOPPED' }
        $color = if ($s.Healthy) { 'Green' } elseif ($s.Listening) { 'Yellow' } else { 'DarkGray' }
        Write-Host ("  {0,-28} {1}" -f $s.Name, $state) -ForegroundColor $color
        $pidText = if ($null -ne $s.Pid) { $s.Pid } else { '-' }
        $procText = if ($s.Process) { $s.Process } else { '' }
        $startText = if ($s.StartedLocal) { $s.StartedLocal } else { '-' }
        Write-Host ("    {0}   PID {1}  {2}  started {3}" -f $s.Url, $pidText, $procText, $startText)
        if ($s.Detail) { Write-Host ("    {0}" -f $s.Detail) -ForegroundColor DarkGray }
    }
    if ($env:PI_WEB_OFFLINE -eq '1') { Write-Host '  OFFLINE GUARD env is set in this console.' -ForegroundColor Yellow }
    Write-Host ''
}

if ($Once) { Show-Status; return }

while ($true) {
    Show-Status
    Write-Host '[R] Refresh   [U] Stop Web UI   [M] Stop model router   [A] Stop both   [Q] Quit' -ForegroundColor Cyan
    $choice = Read-Host 'Choice'
    switch ($choice.Trim().ToLower()) {
        'r' { continue }
        'u' { Stop-RecordedService $Services[1] }
        'm' { Stop-RecordedService $Services[0] }
        'a' { Stop-RecordedService $Services[1]; Stop-RecordedService $Services[0] }
        'q' { return }
        default { Write-Host 'Unknown choice.' }
    }
}
