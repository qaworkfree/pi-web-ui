# Start existing builds only. No downloads, prompts, agent tools or capability tests.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$LlamaServer,
    [Parameter(Mandatory = $true)][string]$RuntimeRepo,
    [string]$ModelsDir = 'D:\IA\modelos-llamacpp',
    [string]$ProjectDir = (Get-Location).Path,
    [ValidateRange(1, 65535)][int]$LlamaPort = 8080,
    [ValidateRange(1, 65535)][int]$UiPort = 8788,
    [ValidateRange(512, 131072)][int]$ContextSize = 4096,
    [ValidateRange(0, 999)][int]$GpuLayers = 0
)
$ErrorActionPreference = 'Stop'
try {
    $UiRepo = Split-Path -Parent $PSScriptRoot
    $LlamaServer = (Resolve-Path -LiteralPath $LlamaServer).Path
    $RuntimeRepo = (Resolve-Path -LiteralPath $RuntimeRepo).Path
    $ModelsDir = (Resolve-Path -LiteralPath $ModelsDir).Path
    $ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
    if (-not (Test-Path -LiteralPath $LlamaServer -PathType Leaf)) { throw 'Select llama-server.exe' }
    if (-not (Test-Path -LiteralPath $ModelsDir -PathType Container)) { throw 'ModelsDir must be a directory' }
    if (-not (Test-Path -LiteralPath $ProjectDir -PathType Container)) { throw 'ProjectDir must be a directory' }
    $RuntimePackage = Join-Path $RuntimeRepo 'packages\coding-agent'
    foreach ($Required in @(
        (Join-Path $RuntimePackage 'dist\index.js'),
        (Join-Path $UiRepo 'dist\server\index.js'),
        (Join-Path $UiRepo 'dist\server\resolve-global-sdk.js'),
        (Join-Path $UiRepo 'web\dist\index.html')
    )) {
        if (-not (Test-Path -LiteralPath $Required)) { throw "Build the repositories first: missing $Required" }
    }
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    if ($LlamaPort -eq $UiPort) { throw 'Use different model and UI ports' }
    foreach ($Port in @($LlamaPort, $UiPort)) {
        $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        try { $Listener.Start() } catch { throw "Port $Port is already in use. Close the previous launcher/server first." }
        finally { $Listener.Stop() }
    }
    # EncodedCommand avoids Windows argument quoting problems with spaces/apostrophes.
    function Quote-Ps([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
    $LlamaArgs = @('--models-dir', $ModelsDir, '--models-max', '1', '--models-autoload',
        '--jinja', '--host', '127.0.0.1', '--port', "$LlamaPort", '--ctx-size', "$ContextSize",
        '--parallel', '1', '--n-gpu-layers', "$GpuLayers", '--threads', '4')
    $ArgumentsText = ($LlamaArgs | ForEach-Object { Quote-Ps $_ }) -join ', '
    $CommandText = "`$Host.UI.RawUI.WindowTitle = 'Workfree - llama.cpp router'; & $(Quote-Ps $LlamaServer) @($ArgumentsText); Write-Host 'llama.cpp stopped. This console stays open for inspection.'"
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
    # Existing agent/data/auth environment settings remain in use. No config files are overwritten.
    $Host.UI.RawUI.WindowTitle = 'Workfree - pi-web-ui'
    Write-Host "Models: $ModelsDir. No model is loaded until you send a chat message."
    Write-Host "Open http://127.0.0.1:$UiPort and select a filename under llama.cpp in the model picker."
    Write-Host 'Keep both consoles open. Ctrl+C stops the UI; close the llama.cpp console separately.'
    Push-Location $UiRepo
    try {
        & $Node --import './dist/server/resolve-global-sdk.js' './dist/server/index.js'
        if ($LASTEXITCODE -ne 0) { throw "UI exited with code $LASTEXITCODE" }
    } finally { Pop-Location }
} catch {
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    # Also retain errors when this script was launched by double-click/another shortcut.
    Read-Host 'Press Enter to close this launcher console (the llama.cpp console is separate)'
}
