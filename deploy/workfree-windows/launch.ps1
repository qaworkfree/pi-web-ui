param([switch]$NoBrowser, [switch]$Repair, [switch]$GitHubOnly, [switch]$Offline)
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = "$PSHOME\Modules;" + $env:PSModulePath
}
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
& "$Root\prepare-personal-storage.ps1"
foreach ($Folder in @('logs','cache','temp')) { New-Item -ItemType Directory -Path (Join-Path $Root $Folder) -Force | Out-Null }
$Lock = $null
$TranscriptStarted = $false
try {
    try { $Lock = [IO.File]::Open("$Root\logs\launcher.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another launcher is running. Wait for it to finish.' }
    Start-Transcript -LiteralPath "$Root\logs\launcher.log" -Force | Out-Null
    $TranscriptStarted = $true
    Write-Host 'pipipiPopopo: check dependencies, update, build, start and open UI'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'Git is required. Install Git for Windows from https://git-scm.com/download/win, then run this launcher again.'
    }
    $Config = Get-Content -LiteralPath "$Root\Personal\Config\service-config.json" -Raw | ConvertFrom-Json
    # Offline guard: -Offline (one launch) or "offlineMode": true in service-config.json (persistent).
    # The UI server enforces it (loopback-only fetch, black-hole proxy for shell children).
    if ($Offline -or ($Config.PSObject.Properties['offlineMode'] -and [bool]$Config.offlineMode)) {
        $env:PI_WEB_OFFLINE = '1'
        Write-Host 'OFFLINE GUARD: outbound network blocked for the UI agent (loopback only). See offline-guard.ps1 for the firewall-level block.'
    } else {
        Remove-Item Env:PI_WEB_OFFLINE -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $Config.llamaExe)) { throw "llama.cpp was not found at $($Config.llamaExe). Set llamaExe in service-config.json to your existing installation." }
    if (-not (Test-Path -LiteralPath $Config.modelsDir -PathType Container)) { throw "Model folder not found: $($Config.modelsDir). Update modelsDir in service-config.json." }
    Write-Host "Using installed llama.cpp unchanged: $($Config.llamaExe)"
    if (-not (Test-Path -LiteralPath "$Root\node\node.exe") -and -not (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe')) {
        Write-Host 'Downloading the portable Node.js runtime and verifying SHA256...'
        $NodeVersion = '22.23.3'
        $ArchiveName = "node-v$NodeVersion-win-x64.zip"
        $NodeBase = "https://nodejs.org/dist/v$NodeVersion"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest "$NodeBase/$ArchiveName" -OutFile "$Root\cache\$ArchiveName" -UseBasicParsing -TimeoutSec 180
        $Checksums = (Invoke-WebRequest "$NodeBase/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 30).Content
        $ChecksumLine = @($Checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $ArchiveName") })
        if ($ChecksumLine.Count -ne 1 -or (Get-FileHash -LiteralPath "$Root\cache\$ArchiveName" -Algorithm SHA256).Hash -ne ($ChecksumLine[0] -split '\s+')[0]) { throw 'Node.js download checksum did not match.' }
        Expand-Archive -LiteralPath "$Root\cache\$ArchiveName" -DestinationPath "$Root\cache\node-download" -Force
        New-Item -ItemType Directory -Path "$Root\node" -Force | Out-Null
        Copy-Item -Path "$Root\cache\node-download\node-v$NodeVersion-win-x64\*" -Destination "$Root\node" -Recurse -Force
    }
    . "$Root\workfree-env.ps1"
    . "$Root\launcher-support.ps1"
    . "$Root\port-listeners.ps1"
    $NodeVersion = [version]((& "$NodeDir\node.exe" --version).TrimStart('v'))
    if ($NodeVersion -lt [version]'22.19.0') { throw 'Node.js 22.19.0 or newer is required.' }
    $PreviousDeployment = if (Test-Path -LiteralPath "$Root\deployment.json") { Get-Content -LiteralPath "$Root\deployment.json" -Raw | ConvertFrom-Json } else { [pscustomobject]@{runtimeRepo=$env:PI_RUNTIME_REPO;uiRepo=$env:PI_UI_REPO} }
    $UiUrl = "http://127.0.0.1:$($Config.uiPort)"
    $Update = $null
    try { $Update = & "$Root\update-stack.ps1" -Repair:$Repair -GitHubOnly:$GitHubOnly }
    catch {
        Write-Warning "Update failed: $($_.Exception.Message)"
        if (-not (Test-Path -LiteralPath (Join-Path $PreviousDeployment.uiRepo 'dist\server\index.js')) -or
            -not (Test-Path -LiteralPath (Join-Path $PreviousDeployment.runtimeRepo 'packages\coding-agent\dist\index.js')) -or
            -not (Test-LauncherDependencies $PreviousDeployment.uiRepo) -or -not (Test-LauncherDependencies $PreviousDeployment.runtimeRepo)) { throw 'No usable previous build is available. Fix the update error and run the launcher again.' }
        Write-Warning 'Keeping the previous working version. Details are in logs\launcher.log.'
    }
    # Validate all metadata before replacing the running services. No inference occurs.
    $NextRuntime = if ($Update -and $Update.Changed) { $Update.Deployment.runtimeRepo } else { $env:PI_RUNTIME_REPO }
    $NextUi = if ($Update -and $Update.Changed) { $Update.Deployment.uiRepo } else { $env:PI_UI_REPO }
    & "$Root\prepare-document-tools.ps1" -UiRepo $NextUi
    & "$Root\prepare-data-tools.ps1"
    $RuntimePath = (Get-Item -LiteralPath $NextRuntime).Target
    if (-not $RuntimePath) { $RuntimePath = $NextRuntime }
    & "$NodeDir\node.exe" "$RuntimePath\scripts\local-model-profiles.mjs" prepare "$Root\ui-data\local-launcher\profiles.json" $Config.modelsDir | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GGUF metadata validation failed. Existing services were left running.' }
    # The user explicitly requested replacing anything on these two configured ports.
    Stop-WorkfreePortListeners @($Config.uiPort, $Config.modelPort)
    try {
        if ($Update -and $Update.Changed) {
            # Both candidate builds have passed before the live folders switch.
            $Update.Deployment = Set-LauncherLiveDeployment $Update.Deployment
        }
        & "$Root\start-llama-server.ps1" | Out-Host
        Wait-LauncherHealth "http://127.0.0.1:$($Config.modelPort)/health" 'llama-process.json' $Config.modelPort -TimeoutSeconds 60
        $Props = Invoke-RestMethod "http://127.0.0.1:$($Config.modelPort)/props" -TimeoutSec 5
        $Catalog = Invoke-RestMethod "http://127.0.0.1:$($Config.modelPort)/models" -TimeoutSec 5
        $Profiles = Get-Content -LiteralPath "$Root\ui-data\local-launcher\profiles.json" -Raw | ConvertFrom-Json
        if ($Props.role -ne 'router' -or $Props.models_autoload -ne $true -or
            @(Compare-Object @($Profiles.models.id) @($Catalog.data.id)).Count -gt 0) {
            throw 'Router did not advertise every prepared GGUF. Inspect logs\llama-server.err.log.'
        }
        if (Test-Path -LiteralPath "$Root\ui-data\auth-users.json") { & "$Root\start-ui.ps1" -ReuseExistingAccount | Out-Host }
        else { & "$Root\start-ui.ps1" | Out-Host }
        Wait-LauncherHealth "$UiUrl/api/health" 'ui-process.json' $Config.uiPort -TimeoutSeconds 60
    } catch {
        if (-not $Update -or -not $Update.Changed) { throw }
        Write-Warning "New UI did not start: $($_.Exception.Message). Restoring the previous build."
        $FailedUi = Get-LauncherOwnedProcess 'ui-process.json' $Config.uiPort
        if ($FailedUi) { Stop-Process -Id $FailedUi.Id; $FailedUi.WaitForExit() }
        Set-LauncherLiveDeployment $PreviousDeployment | Out-Null
        & "$Root\start-ui.ps1" -ReuseExistingAccount | Out-Host
        Wait-LauncherHealth "$UiUrl/api/health" 'ui-process.json' $Config.uiPort -TimeoutSeconds 60
    }
    $OpenUrl = $UiUrl
    Write-Host "UI ready: $OpenUrl -- sign in with your existing account."
    if (-not $NoBrowser) { Start-Process $OpenUrl }
} catch {
    Write-Host "Launcher error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($TranscriptStarted) { Stop-Transcript | Out-Null }
    if ($Lock) { $Lock.Dispose() }
}
