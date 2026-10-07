param([switch]$UseLauncherCredentials)
. "$PSScriptRoot\workfree-env.ps1"
$Config = Get-Content -LiteralPath "$Root\service-config.json" -Raw | ConvertFrom-Json
$env:WORKFREE_UI_URL = "http://127.0.0.1:$($Config.uiPort)"
$env:WORKFREE_EXPECT_PI_VERSION = (Get-Content -LiteralPath "$env:PI_RUNTIME_REPO\packages\coding-agent\package.json" -Raw | ConvertFrom-Json).version
try {
    if ($UseLauncherCredentials) {
        $env:WORKFREE_UI_USERNAME = $env:PI_WEB_AUTH_USERNAME
        $env:WORKFREE_UI_PASSWORD = $env:PI_WEB_AUTH_PASSWORD
    } else {
        $env:WORKFREE_UI_USERNAME = Read-Host 'UI username (admin)'
        $LoginSecret = Read-Host 'UI password (local only)' -AsSecureString
        $env:WORKFREE_UI_PASSWORD = [System.Net.NetworkCredential]::new('', $LoginSecret).Password
    }
    # Node resolves import.meta.url through junctions; invoke the physical file
    # so the validator's direct-entry guard actually executes.
    $ValidationRepo = $env:PI_UI_REPO
    $RepoItem = Get-Item -LiteralPath $ValidationRepo
    if ($RepoItem.LinkType -eq 'Junction') { $ValidationRepo = [string](@($RepoItem.Target)[0]) }
    & "$NodeDir\node.exe" "$ValidationRepo\scripts\check-workfree-deployment.mjs" 2>&1 | Tee-Object -FilePath "$Root\logs\deployment-validation.log"
    if ($LASTEXITCODE -ne 0) { throw "Deployment validation failed ($LASTEXITCODE). See logs\deployment-validation.log" }
} finally {
    Remove-Item Env:WORKFREE_UI_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:WORKFREE_UI_USERNAME -ErrorAction SilentlyContinue
    $LoginSecret = $null
}
