$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = "$PSHOME\Modules;" + $env:PSModulePath
}
$Root = $PSScriptRoot
$ServiceConfigPath = "$Root\Personal\Config\service-config.json"
$NodeDir = if (Test-Path -LiteralPath "$Root\node\node.exe") { "$Root\node" } else { 'C:\Program Files\nodejs' }
$env:PATH = "$Root\node;$NodeDir;" + $env:PATH
if (Test-Path -LiteralPath "$Root\tools\python\Scripts\python.exe") { $env:PATH = "$Root\tools\python\Scripts;" + $env:PATH }
$env:npm_config_cache = "$Root\cache\npm"
$env:TEMP = "$Root\Personal\Temp"
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:TMP = $env:TEMP
$env:PI_RUNTIME_REPO = "$Root\pipipiPopopo"
$env:PI_UI_REPO = "$Root\pi-web-ui"
if (Test-Path -LiteralPath "$Root\deployment.json") {
    $Deployment = Get-Content -LiteralPath "$Root\deployment.json" -Raw | ConvertFrom-Json
    $env:PI_RUNTIME_REPO = $Deployment.runtimeRepo
    $env:PI_UI_REPO = $Deployment.uiRepo
}
$env:PI_CODING_AGENT_DIR = "$Root\Personal\Agent"
$env:PI_WEB_DATA_DIR = "$Root\Personal\UI"
$env:PI_WEB_UPLOAD_DIR = "$Root\Personal\Uploads"
$env:PI_WEB_ATTACHMENT_DIR = "$Root\Personal\Attachments"
$env:PI_WEB_OCR_CACHE = "$Root\Personal\UI\ocr-languages"
$env:PI_WEB_UPLOAD_RETENTION_DAYS = '0'
$PrivateIntegrationsPath = "$Root\Personal\Config\integrations.json"
if (Test-Path -LiteralPath $PrivateIntegrationsPath) {
    $PrivateIntegrations = Get-Content -LiteralPath $PrivateIntegrationsPath -Raw | ConvertFrom-Json
    if ($PrivateIntegrations.takkle.supabaseUrl) { $env:TAKKLE_SUPABASE_URL = [string]$PrivateIntegrations.takkle.supabaseUrl }
    if ($PrivateIntegrations.takkle.accountEmail) { $env:TAKKLE_ACCOUNT_EMAIL = [string]$PrivateIntegrations.takkle.accountEmail }
}
function Invoke-CheckedNpm {
    param([string[]]$CommandArgs, [string]$LogName)
    $SavedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & "$NodeDir\npm.cmd" @CommandArgs 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath "$Root\logs\$LogName"
        $NativeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $SavedPreference }
    if ($NativeExit -ne 0) { throw "npm $($CommandArgs -join ' ') failed: $NativeExit (logs\$LogName)" }
}
