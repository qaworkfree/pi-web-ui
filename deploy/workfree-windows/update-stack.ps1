param([switch]$Repair, [switch]$GitHubOnly)
. "$PSScriptRoot\workfree-env.ps1"
. "$PSScriptRoot\launcher-support.ps1"

$RuntimeSource = $env:PI_RUNTIME_REPO
$UiSource = $env:PI_UI_REPO
$Repositories = @(
    [pscustomobject]@{Kind='runtime';Source=$RuntimeSource;Remote='https://github.com/qaworkfree/pipipiPopopo';Artifact='packages\coding-agent\dist\index.js'},
    [pscustomobject]@{Kind='ui';Source=$UiSource;Remote='https://github.com/qaworkfree/pi-web-ui';Artifact='dist\server\index.js'}
)
$Receipt = if (Test-Path -LiteralPath "$Root\deployment.json") { Get-Content -LiteralPath "$Root\deployment.json" -Raw | ConvertFrom-Json } else { $null }
$NeedsBuild = [bool]$Repair
foreach ($Repository in $Repositories) {
    Write-Host "Checking GitHub: $($Repository.Remote)"
    $ActualRemote = (Invoke-LauncherGit $Repository.Source @('remote','get-url','origin')).Trim().TrimEnd('/').Replace('.git','')
    if ($ActualRemote -ne $Repository.Remote) { throw "Unexpected Git remote: $ActualRemote. Check the repository before updating." }
    # Fetch changes only; original working copies and their local edits are preserved.
    Invoke-LauncherGit $Repository.Source @('-c','http.connectTimeout=15','-c','http.lowSpeedLimit=1024','-c','http.lowSpeedTime=30','fetch','--no-tags','origin','main') | Out-Null
    $TargetCommit = (Invoke-LauncherGit $Repository.Source @('rev-parse','FETCH_HEAD')).Trim()
    $Snapshot = Get-LauncherSnapshot $Repository.Source "$Root\logs\launcher-$($Repository.Kind)-local.patch"
    $Repository | Add-Member -NotePropertyName Target -NotePropertyValue $TargetCommit
    $Repository | Add-Member -NotePropertyName Snapshot -NotePropertyValue $Snapshot
    $ReceiptFingerprint = if ($Receipt) { $Receipt.($Repository.Kind + 'Fingerprint') } else { $null }
    $SourceEdits = @(Invoke-LauncherGit $Repository.Source @('diff','--name-only','HEAD','--','.',':(exclude)plugins/*/client/vendor/*'))
    if ($GitHubOnly -and ($SourceEdits.Count -gt 0 -or $Snapshot.Untracked.Count -gt 0)) { $NeedsBuild = $true }
    if ($TargetCommit -ne $Snapshot.Head -or $ReceiptFingerprint -ne $Snapshot.Fingerprint -or
        -not (Test-Path -LiteralPath (Join-Path $Repository.Source $Repository.Artifact)) -or
        -not (Test-LauncherDependencies $Repository.Source)) { $NeedsBuild = $true }
}
if (-not $NeedsBuild) {
    Write-Host 'GitHub, dependencies and cached builds are up to date.'
    return [pscustomobject]@{Changed=(-not $Receipt.liveFolders); Deployment=$Receipt}
}

$ReleaseRoot = "$Root\cache\releases\$([datetime]::UtcNow.ToString('yyyyMMdd-HHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null
$Next = [ordered]@{builtUtc=[datetime]::UtcNow.ToString('o')}
foreach ($Repository in $Repositories) {
    $Candidate = Join-Path $ReleaseRoot $Repository.Kind
    Write-Host "Preparing $($Repository.Kind) update in $Candidate"
    New-LauncherCandidate $Repository.Source $Candidate $Repository.Target $Repository.Remote $Repository.Snapshot -GitHubOnly:$GitHubOnly
    Invoke-LauncherBuild $Candidate $Repository.Kind | Out-Host
    $Next[$Repository.Kind + 'Repo'] = $Candidate
    $Next[$Repository.Kind + 'Commit'] = $Repository.Target
    $Next[$Repository.Kind + 'Fingerprint'] = (Get-LauncherSnapshot $Candidate (Join-Path $ReleaseRoot "$($Repository.Kind)-customizations.patch")).Fingerprint
}
# Do not promote here: the launcher switches only after both builds pass.
[pscustomobject]@{Changed=$true; Deployment=[pscustomobject]$Next}
