# One-click visible startup. Dependency preparation only; no model downloads or inference tests.
[CmdletBinding()]
param(
    [string]$LlamaServer,
    [string]$RuntimeRepo,
    [string]$ModelsDir = 'D:\IA\modelos-llamacpp',
    [string]$ProjectDir,
    [ValidateRange(1, 65535)][int]$LlamaPort = 8080,
    [ValidateRange(1, 65535)][int]$UiPort = 8788,
    [ValidateRange(0, 999)][int]$GpuLayers = 0,
    [switch]$Rebuild,
    [switch]$SetupOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$ExitCode = 0
try {
    $UiRepo = Split-Path -Parent $PSScriptRoot
    . (Join-Path $PSScriptRoot 'workfree-launcher-functions.ps1')
    $StateDir = Join-Path $UiRepo '.pi-web\local-launcher'
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $ConfigPath = Join-Path $StateDir 'launcher.json'
    if (Test-Path -LiteralPath $ConfigPath) {
        $Saved = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
        foreach ($Name in @('LlamaServer', 'RuntimeRepo', 'ModelsDir', 'ProjectDir', 'LlamaPort', 'UiPort', 'GpuLayers')) {
            if (-not $PSBoundParameters.ContainsKey($Name) -and $null -ne $Saved.$Name) {
                Set-Variable -Name $Name -Value $Saved.$Name
            }
        }
    }
    if (-not $RuntimeRepo) { $RuntimeRepo = Join-Path (Split-Path -Parent $UiRepo) 'pipipiPopopo' }
    if (-not (Test-Path -LiteralPath $RuntimeRepo -PathType Container)) {
        $RuntimeRepo = Read-Host 'Full path to your existing pipipiPopopo checkout'
    }
    if (-not $ProjectDir) { $ProjectDir = $UiRepo }
    if (-not $LlamaServer) {
        $OnPath = Get-Command llama-server.exe -ErrorAction SilentlyContinue
        if ($OnPath) { $LlamaServer = $OnPath.Source }
        else {
            $Root = Split-Path -Parent $UiRepo
            $Candidates = @('llama.cpp\build\bin\Release', 'llama.cpp\build\bin', 'llama.cpp',
                'llama-cpp', 'llama', 'bin', 'llama-bin')
            foreach ($Directory in $Candidates) {
                $Candidate = Join-Path (Join-Path $Root $Directory) 'llama-server.exe'
                if (Test-Path -LiteralPath $Candidate -PathType Leaf) { $LlamaServer = $Candidate; break }
            }
            if (-not $LlamaServer) { $LlamaServer = Read-Host 'Full path to existing llama-server.exe (router support required)' }
        }
    }
    $LlamaServer = (Resolve-Path -LiteralPath $LlamaServer).Path
    $RuntimeRepo = (Resolve-Path -LiteralPath $RuntimeRepo).Path
    $ModelsDir = (Resolve-Path -LiteralPath $ModelsDir).Path
    $ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
    if (-not (Test-Path -LiteralPath $LlamaServer -PathType Leaf)) { throw 'Select llama-server.exe' }
    if (-not (Test-Path -LiteralPath $ModelsDir -PathType Container)) { throw 'ModelsDir must be a directory' }
    if (-not (Test-Path -LiteralPath $ProjectDir -PathType Container)) { throw 'ProjectDir must be a directory' }
    $RuntimePackage = Join-Path $RuntimeRepo 'packages\coding-agent'
    if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRepo 'scripts\local-model-profiles.mjs'))) {
        throw 'Update pipipiPopopo from GitHub main first: local-model-profiles.mjs is missing. Preserve local edits.'
    }
    if ($LlamaPort -eq $UiPort) { throw 'Use different model and UI ports' }
    [IO.File]::WriteAllText($ConfigPath, (@{ LlamaServer = $LlamaServer; RuntimeRepo = $RuntimeRepo;
        ModelsDir = $ModelsDir; ProjectDir = $ProjectDir; LlamaPort = $LlamaPort; UiPort = $UiPort;
        GpuLayers = $GpuLayers } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    Initialize-WorkfreeBuilds $UiRepo $RuntimeRepo $StateDir -Rebuild:$Rebuild
    foreach ($Required in @(
        (Join-Path $RuntimePackage 'dist\index.js'),
        (Join-Path $UiRepo 'dist\server\index.js'),
        (Join-Path $UiRepo 'dist\server\resolve-global-sdk.js'),
        (Join-Path $UiRepo 'web\dist\index.html')
    )) {
        if (-not (Test-Path -LiteralPath $Required)) { throw "Build the repositories first: missing $Required" }
    }
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    $ProfileScript = Join-Path $RuntimeRepo 'scripts\local-model-profiles.mjs'
    $ProfilePath = Join-Path $StateDir 'profiles.json'
    $ProfileText = & $Node $ProfileScript prepare $ProfilePath $ModelsDir
    if ($LASTEXITCODE -ne 0) { throw 'GGUF metadata preparation failed; inspect the visible error. No services were stopped.' }
    $Profiles = ($ProfileText -join "`n") | ConvertFrom-Json
    foreach ($Model in $Profiles.models) {
        Write-Host "$($Model.name): selected context $($Model.contextWindow), GGUF limit $($Model.contextLimit), max output $($Model.maxTokens)"
    }
    # Reject unsupported llama.cpp BEFORE stopping an existing service.
    $PreviousErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue' # Windows PowerShell 5 treats native stderr as ErrorRecord.
        $Help = & $LlamaServer --help 2>&1 | Out-String
        $HelpExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $PreviousErrorPreference }
    if ($HelpExitCode -ne 0 -or $Help -notmatch '--models-preset' -or $Help -notmatch '--models-autoload') {
        throw 'This llama-server lacks router/preset support. Use v0.5.0 or a compatible newer build.'
    }
    if ($SetupOnly) { Write-Host 'Preparation complete. No services were stopped or started.'; return }
    Stop-WorkfreePortListeners @($LlamaPort, $UiPort)
    # EncodedCommand avoids Windows argument quoting problems with spaces/apostrophes.
    function Quote-Ps([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
    $LlamaArgs = @('--models-preset', $Profiles.presetPath, '--models-max', '1', '--models-autoload',
        '--jinja', '--host', '127.0.0.1', '--port', "$LlamaPort",
        '--parallel', '1', '--n-gpu-layers', "$GpuLayers", '--threads', '4')
    $ArgumentsText = ($LlamaArgs | ForEach-Object { Quote-Ps $_ }) -join ', '
    # Remove inherited llama CLI overrides in the CHILD only; they would override per-GGUF presets.
    $CommandText = "Get-ChildItem Env:LLAMA_ARG_* | Remove-Item; `$Host.UI.RawUI.WindowTitle = 'Workfree - llama.cpp router'; & $(Quote-Ps $LlamaServer) @($ArgumentsText); Write-Host 'llama.cpp stopped. This console stays open for inspection.'"
    $Encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($CommandText))
    $PowerShell = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $PowerShell)) { $PowerShell = Join-Path $PSHOME 'pwsh.exe' }
    $Router = Start-Process -FilePath $PowerShell -ArgumentList @('-NoProfile', '-NoExit', '-EncodedCommand', $Encoded) `
        -WindowStyle Normal -PassThru
    Write-Host "llama.cpp console PID: $($Router.Id). Close its window to stop the model server."
    $BaseUrl = "http://127.0.0.1:$LlamaPort"
    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
        if ($Router.HasExited) { throw 'llama.cpp console exited; inspect its output' }
        try {
            $Health = Invoke-WebRequest -Uri "$BaseUrl/health" -UseBasicParsing -TimeoutSec 1
            if ($Health.StatusCode -eq 200) { $Ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $Ready) { throw 'llama.cpp did not become ready. Inspect its visible console; no UI was started.' }
    $Props = Invoke-RestMethod -Uri "$BaseUrl/props" -TimeoutSec 3
    if ($Props.role -ne 'router' -or $Props.models_autoload -ne $true) {
        throw 'Expected llama.cpp router mode with model autoload enabled; inspect its console'
    }
    $env:LLAMA_BASE_URL = $BaseUrl
    $env:PI_WEB_SDK = 'global'
    $env:PI_WEB_SDK_DIR = $RuntimePackage
    $env:PI_WEB_HOST = '127.0.0.1'
    $env:PI_WEB_PORT = "$UiPort"
    $env:PI_WEB_CWD = $ProjectDir
    $env:PI_WEB_LOCAL_MODEL_PROFILES = $ProfilePath
    $env:PI_WEB_LOCAL_MODEL_PROFILE_SCRIPT = $ProfileScript
    # Existing agent/data/auth environment settings remain in use. No config files are overwritten.
    $Host.UI.RawUI.WindowTitle = 'Workfree - pi-web-ui'
    Write-Host "Models: $ModelsDir. No model is loaded until you send a chat message."
    Write-Host "Open http://127.0.0.1:$UiPort and select a filename under llama.cpp in the model picker."
    Write-Host 'Manage models -> llama.cpp: choose each Context and Max output within its displayed GGUF limit, then Save.'
    Write-Host 'Keep both consoles open. Ctrl+C stops the UI; close the llama.cpp console separately.'
    Push-Location $UiRepo
    try {
        & $Node --import './dist/server/resolve-global-sdk.js' './dist/server/index.js'
        if ($LASTEXITCODE -ne 0) { throw "UI exited with code $LASTEXITCODE" }
    } finally { Pop-Location }
} catch {
    $ExitCode = 1
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    # Also retain errors when this script was launched by double-click/another shortcut.
    Read-Host 'Press Enter to close this launcher console (the llama.cpp console is separate)'
}
exit $ExitCode
