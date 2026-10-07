# Replaces listeners only on the ports explicitly selected by the launcher.
function Stop-WorkfreePortListeners {
    param([int[]]$Ports)
    # Protect this console and all its ancestors, including the double-click cmd shell.
    $Protected = @([int]$PID, 0, 4)
    $Current = [int]$PID
    for ($Depth = 0; $Depth -lt 20; $Depth++) {
        $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$Current" -ErrorAction Stop
        if (-not $ProcessInfo -or $ProcessInfo.ParentProcessId -eq 0) { break }
        $Current = [int]$ProcessInfo.ParentProcessId
        $Protected += $Current
    }
    for ($Attempt = 0; $Attempt -lt 5; $Attempt++) {
        # Query all listening interfaces (IPv4/IPv6), not just loopback.
        $ListenerErrors = @()
        $Listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue -ErrorVariable ListenerErrors |
            Where-Object { $Ports -contains $_.LocalPort })
        if (@($ListenerErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' }).Count) {
            throw 'Cannot inspect listening ports. Resolve the displayed Windows networking error before retrying.'
        }
        if ($Listeners.Count -eq 0) { return }
        foreach ($Owner in @($Listeners.OwningProcess | Sort-Object -Unique)) {
            if ($Protected -contains [int]$Owner) { throw "Port owner PID $Owner is protected; close it manually." }
            $Target = [int]$Owner
            $OwnerInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$Owner" -ErrorAction Stop
            if ($OwnerInfo -and $OwnerInfo.ParentProcessId) {
                $ParentInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($OwnerInfo.ParentProcessId)" -ErrorAction Stop
                # Stop the known pi-web-ui service watchdog as well as its listening child.
                # Ordinary parent shells and unrelated processes are left running.
                if ($ParentInfo -and $ParentInfo.Name -match '^(powershell|pwsh)\.exe$' -and
                    $ParentInfo.CommandLine -match '\\pi-web-ui[^"\r\n]*\.ps1(?:"|\s|$)') {
                    $Target = [int]$ParentInfo.ProcessId
                }
            }
            if ($Protected -contains $Target) { throw "Cannot stop protected PID $Target; close the old service manually." }
            Write-Host "Stopping listener PID $Owner on selected ports $($Ports -join ', ') (tree PID $Target)."
            & taskkill.exe /PID $Target /T /F
            if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $Owner -ErrorAction SilentlyContinue)) {
                throw "Cannot stop PID $Owner. Inspect the visible error; administrator rights may be required."
            }
        }
        Start-Sleep -Milliseconds 300
    }
    throw "Selected ports are still occupied by a restarting service. Stop its supervisor and retry."
}
