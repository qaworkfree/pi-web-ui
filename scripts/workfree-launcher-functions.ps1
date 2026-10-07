# Shared, testable launcher operations. Dot-sourcing performs no startup work.
function Invoke-WorkfreeChecked {
    param([string]$Command, [string[]]$CommandArgs)
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

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

function Get-WorkfreeBuildFingerprint {
    param([string]$Repo)
    # Include dirty source timestamps and sizes; never change Git state.
    $Files = & git -c core.quotepath=false -C $Repo ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect repository: $Repo" }
    $Parts = foreach ($File in $Files) {
        $Path = Join-Path $Repo $File
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $Info = Get-Item -LiteralPath $Path -Force
            "$File|$($Info.Length)|$($Info.LastWriteTimeUtc.Ticks)"
        } else { "$File|missing" }
    }
    $Hash = [System.Security.Cryptography.SHA256]::Create()
    try {
        $Version = & node --version
        if ($LASTEXITCODE -ne 0) { throw 'Node is unavailable' }
        return ([BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(
            "$Version`n$($Parts -join "`n")")))).Replace('-', '').ToLowerInvariant()
    } finally { $Hash.Dispose() }
}

function Initialize-WorkfreeBuilds {
    param([string]$UiRepo, [string]$RuntimeRepo, [string]$StateDir, [switch]$Rebuild)
    $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    $NodeVersionText = & $Node --version
    if ($LASTEXITCODE -ne 0 -or [version]$NodeVersionText.TrimStart('v') -lt [version]'22.19.0') {
        throw 'Install Node.js >=22.19 (Node 24 LTS recommended), then reopen the launcher.'
    }
    foreach ($Repo in @($RuntimeRepo, $UiRepo)) {
        Push-Location $Repo
        try {
            $Fingerprint = Get-WorkfreeBuildFingerprint $Repo
            $Kind = if ($Repo -eq $UiRepo) { 'ui' } else { 'runtime' }
            $Stamp = Join-Path $StateDir "$Kind-build.txt"
            $Built = if ($Kind -eq 'ui') {
                (Test-Path 'dist\server\index.js') -and (Test-Path 'web\dist\index.html')
            } else { Test-Path 'packages\coding-agent\dist\index.js' }
            $Dependencies = Test-Path 'node_modules\.package-lock.json'
            if (-not $Rebuild -and $Built -and $Dependencies -and (Test-Path $Stamp) -and
                (Get-Content -LiteralPath $Stamp -Raw).Trim() -eq $Fingerprint) { continue }
            Write-Host "Preparing $Kind dependencies/build (existing source and credentials are preserved)."
            Invoke-WorkfreeChecked $Npm @('ci', '--ignore-scripts')
            if ($Kind -eq 'runtime') {
                $Data = Join-Path $Repo 'packages\ai\src\providers\data'
                if (-not (Test-Path $Data)) {
                    # npm pack verifies registry integrity; retain the package's original data manifest.
                    $Package = Get-Content 'packages\ai\package.json' -Raw | ConvertFrom-Json
                    $Cache = Join-Path $StateDir ('catalog-' + $Package.version)
                    New-Item -ItemType Directory -Force -Path $Cache | Out-Null
                    $PackText = & $Npm pack "$($Package.name)@$($Package.version)" --ignore-scripts --json --pack-destination $Cache
                    if ($LASTEXITCODE -ne 0) { throw 'Exact-version model catalog download failed; see runtime hydration guide.' }
                    $Pack = ($PackText -join "`n" | ConvertFrom-Json)[0]
                    Invoke-WorkfreeChecked 'tar.exe' @('-xzf', (Join-Path $Cache $Pack.filename), '-C', $Cache,
                        'package/dist/providers/data')
                    Copy-Item -LiteralPath (Join-Path $Cache 'package\dist\providers\data') -Destination $Data -Recurse
                }
                Invoke-WorkfreeChecked $Npm @('run', 'check:model-data', '--workspace=@earendil-works/pi-ai')
                Invoke-WorkfreeChecked $Npm @('run', 'build:offline')
            } else {
                Invoke-WorkfreeChecked $Npm @('rebuild', 'node-pty')
                Invoke-WorkfreeChecked $Npm @('run', 'build')
            }
            [IO.File]::WriteAllText($Stamp, $Fingerprint, [Text.UTF8Encoding]::new($false))
        } finally { Pop-Location }
    }
}
