param([switch]$ReuseExistingAccount)
. "$PSScriptRoot\workfree-env.ps1"
$Config = Get-Content -LiteralPath $ServiceConfigPath -Raw | ConvertFrom-Json
if (Get-NetTCPConnection -LocalPort $Config.uiPort -State Listen -ErrorAction SilentlyContinue) { throw "UI port $($Config.uiPort) is already occupied. Run check-services.ps1." }
$Host.UI.RawUI.WindowTitle = 'Workfree UI - local password setup'
$env:PI_WEB_ENGINE = 'pi'
$env:PI_WEB_LOCALE = 'en'
$env:PI_WEB_SDK = 'global'
$env:PI_WEB_SDK_DIR = "$env:PI_RUNTIME_REPO\packages\coding-agent"
$env:PI_WEB_DATA_DIR = "$Root\Personal\UI"
$env:PI_WEB_OCR_CACHE = "$Root\Personal\UI\ocr-languages"
$env:PI_WEB_CWD = "$Root\test-project"
$env:LLAMA_BASE_URL = "http://127.0.0.1:$($Config.modelPort)"
$env:PI_WEB_LOCAL_MODEL_PROFILES = "$Root\Personal\UI\local-launcher\profiles.json"
$RuntimePath = (Get-Item -LiteralPath $env:PI_RUNTIME_REPO).Target
if (-not $RuntimePath) { $RuntimePath = $env:PI_RUNTIME_REPO }
$env:PI_WEB_LOCAL_MODEL_PROFILE_SCRIPT = "$RuntimePath\scripts\local-model-profiles.mjs"
$env:PI_WEB_AUTO_RESUME = '0'
$env:PI_WEB_START_BLANK = '1'
# No folder is opened automatically: the UI forces an explicit selection of the
# folder(s) to expose (selection grants filesystem access). PI_WEB_CWD above is
# only the technical fallback and is not remembered as a project.
$env:PI_WEB_REQUIRE_PROJECT = '1'
& "$NodeDir\node.exe" "$Root\prepare-local-ui.mjs" $Root $Config.startupModelId
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize local model selection.' }
$env:PI_WEB_HOST = '127.0.0.1'
$env:PI_WEB_PORT = [string]$Config.uiPort
$env:PI_WEB_PLUGIN_CATALOG_URL = 'off'
$env:PI_WEB_AUTH_USERNAME = 'admin'
$env:PI_WEB_ALLOW_HOSTS = '127.0.0.1,localhost'
Remove-Item Env:PI_WEB_ALLOW_ORIGINS -ErrorAction SilentlyContinue
$PrivateNetworkFile = "$Root\Personal\Config\ui-network.json"
if (Test-Path -LiteralPath $PrivateNetworkFile) {
    $PrivateNetwork = Get-Content -LiteralPath $PrivateNetworkFile -Raw | ConvertFrom-Json
    if ($PrivateNetwork.allowedHosts) { $env:PI_WEB_ALLOW_HOSTS = [string]$PrivateNetwork.allowedHosts }
    if ($PrivateNetwork.allowedOrigins) { $env:PI_WEB_ALLOW_ORIGINS = [string]$PrivateNetwork.allowedOrigins }
}
$env:PI_WEB_TRUST_PROXY = 'loopback'
if ($ReuseExistingAccount) {
    if (-not (Test-Path -LiteralPath "$Root\ui-data\auth-users.json")) { throw 'No existing UI account is available; start without -ReuseExistingAccount.' }
    Remove-Item Env:PI_WEB_AUTH_PASSWORD -ErrorAction SilentlyContinue
} else {
    $LoginSecret = Read-Host 'UI admin password (local only; existing accounts are preserved)' -AsSecureString
}
try {
    if (-not $ReuseExistingAccount) {
        $env:PI_WEB_AUTH_PASSWORD = [System.Net.NetworkCredential]::new('', $LoginSecret).Password
        if ([string]::IsNullOrWhiteSpace($env:PI_WEB_AUTH_PASSWORD)) { throw 'A non-empty password is required.' }
    }
    $UiProcess = Start-Process -FilePath "$NodeDir\node.exe" -ArgumentList '--import ./dist/server/resolve-global-sdk.js dist/server/index.js' -WorkingDirectory $env:PI_UI_REPO -WindowStyle Hidden -RedirectStandardOutput "$Root\logs\ui.log" -RedirectStandardError "$Root\logs\ui.err.log" -PassThru
    [pscustomobject]@{Pid=$UiProcess.Id;Exe="$NodeDir\node.exe";StartedUtc=$UiProcess.StartTime.ToUniversalTime().ToString('o');Port=$Config.uiPort} | ConvertTo-Json | Set-Content -LiteralPath "$Root\logs\ui-process.json"
    $UiUrl = "http://127.0.0.1:$($Config.uiPort)"
    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
        if ($UiProcess.HasExited) { throw 'UI exited; inspect logs\ui.err.log' }
        try { $Health = Invoke-RestMethod "$UiUrl/api/health" -TimeoutSec 2; $Ready = $true; break } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $Ready) { throw 'UI health did not become ready.' }
    $Health | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath "$Root\logs\ui-health.json"
    Get-Content -LiteralPath "$Root\logs\ui.err.log"
    Get-Content -LiteralPath "$Root\logs\ui.log"
    if (-not $ReuseExistingAccount) { & "$Root\validate-deployment.ps1" -UseLauncherCredentials }
    Write-Host "UI ready: $UiUrl (username admin). Password is never saved in launcher scripts."
} finally {
    Remove-Item Env:PI_WEB_AUTH_PASSWORD -ErrorAction SilentlyContinue
    $LoginSecret = $null
}
