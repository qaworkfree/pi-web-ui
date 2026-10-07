$ErrorActionPreference = 'Stop'
$StackRoot = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Path "$StackRoot\logs" -Force | Out-Null
. "$StackRoot\workfree-env.ps1"
. "$StackRoot\launcher-support.ps1"
$Results = [Collections.Generic.List[string]]::new()
function Assert-LauncherTest {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw "FAILED: $Name" }
    $Results.Add($Name)
    Write-Host "PASS: $Name"
}

# All Git mutations below are confined to newly created test repositories.
$Fixture = "$StackRoot\temp\launcher-tests-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Fixture -Force | Out-Null
$Source = "$Fixture\source"
$Upstream = "$Fixture\upstream"
Invoke-LauncherGit $Fixture @('init','--initial-branch=main',$Source) | Out-Null
Set-Content -LiteralPath "$Source\custom.txt" -Value 'base' -Encoding ASCII
Set-Content -LiteralPath "$Source\upstream.txt" -Value 'v1' -Encoding ASCII
Invoke-LauncherGit $Source @('add','custom.txt','upstream.txt') | Out-Null
Invoke-LauncherGit $Source @('-c','user.name=Launcher test','-c','user.email=launcher@example.invalid','commit','-m','fixture base') | Out-Null
Invoke-LauncherGit $Fixture @('clone','--no-hardlinks',$Source,$Upstream) | Out-Null
Set-Content -LiteralPath "$Source\custom.txt" -Value 'local English and mobile fixes' -Encoding ASCII
[IO.File]::WriteAllBytes("$Source\extra.bin", [byte[]]@(0,255,10,128))
[IO.File]::WriteAllText("$Source\extra.txt", "local text`r`n", [Text.UTF8Encoding]::new($false))
$Snapshot = Get-LauncherSnapshot $Source "$Fixture\local.patch"
Set-Content -LiteralPath "$Upstream\upstream.txt" -Value 'v2' -Encoding ASCII
Copy-Item -LiteralPath "$Source\extra.bin" -Destination "$Upstream\extra.bin"
Copy-Item -LiteralPath "$Source\extra.txt" -Destination "$Upstream\extra.txt"
Invoke-LauncherGit $Upstream @('add','upstream.txt','extra.bin','extra.txt') | Out-Null
Invoke-LauncherGit $Upstream @('-c','user.name=Launcher test','-c','user.email=launcher@example.invalid','commit','-m','fixture update') | Out-Null
Invoke-LauncherGit $Source @('fetch',$Upstream,'main') | Out-Null
$Target = (Invoke-LauncherGit $Source @('rev-parse','FETCH_HEAD')).Trim()
New-LauncherCandidate $Source "$Fixture\candidate" $Target 'https://github.com/qaworkfree/pi-web-ui' $Snapshot
Assert-LauncherTest ((Get-Content -LiteralPath "$Fixture\candidate\custom.txt" -Raw).Trim() -eq 'local English and mobile fixes') 'Tracked customizations survive an upstream update'
Assert-LauncherTest ((Get-Content -LiteralPath "$Fixture\candidate\upstream.txt" -Raw).Trim() -eq 'v2') 'Candidate includes the new upstream change'
Assert-LauncherTest ((Get-FileHash -LiteralPath "$Source\extra.bin").Hash -eq (Get-FileHash -LiteralPath "$Fixture\candidate\extra.bin").Hash) 'Untracked binary file is preserved'
Assert-LauncherTest ((Get-Content -LiteralPath "$Fixture\candidate\extra.txt" -Raw).Trim() -eq 'local text') 'Matching newly tracked file is accepted across Windows line endings'
Assert-LauncherTest ((Get-LauncherSnapshot $Source "$Fixture\source-after.patch").Fingerprint -eq $Snapshot.Fingerprint) 'Original checkout and its edits remain unchanged'
New-LauncherCandidate $Source "$Fixture\github-only" $Target 'https://github.com/qaworkfree/pi-web-ui' $Snapshot -GitHubOnly
Assert-LauncherTest ((Get-Content -LiteralPath "$Fixture\github-only\custom.txt" -Raw).Trim() -eq 'base') 'GitHub-only update does not reapply older local patches'

[IO.File]::WriteAllBytes("$Upstream\extra.bin", [byte[]]@(1,2,3))
Invoke-LauncherGit $Upstream @('add','extra.bin') | Out-Null
Invoke-LauncherGit $Upstream @('-c','user.name=Launcher test','-c','user.email=launcher@example.invalid','commit','-m','fixture untracked mismatch') | Out-Null
Invoke-LauncherGit $Source @('fetch',$Upstream,'main') | Out-Null
$MismatchCommit = (Invoke-LauncherGit $Source @('rev-parse','FETCH_HEAD')).Trim()
$MismatchRejected = $false
try { New-LauncherCandidate $Source "$Fixture\mismatch" $MismatchCommit 'https://github.com/qaworkfree/pi-web-ui' $Snapshot }
catch { $MismatchRejected = $_.Exception.Message -match 'different version.*extra.bin' }
Assert-LauncherTest ($MismatchRejected -and (Get-LauncherSnapshot $Source "$Fixture\source-after-mismatch.patch").Fingerprint -eq $Snapshot.Fingerprint) 'Different newly tracked file is rejected without altering local content'

Set-Content -LiteralPath "$Upstream\custom.txt" -Value 'conflicting upstream change' -Encoding ASCII
Invoke-LauncherGit $Upstream @('add','custom.txt') | Out-Null
Invoke-LauncherGit $Upstream @('-c','user.name=Launcher test','-c','user.email=launcher@example.invalid','commit','-m','fixture conflict') | Out-Null
Invoke-LauncherGit $Source @('fetch',$Upstream,'main') | Out-Null
$ConflictCommit = (Invoke-LauncherGit $Source @('rev-parse','FETCH_HEAD')).Trim()
$ConflictRejected = $false
try { New-LauncherCandidate $Source "$Fixture\conflict" $ConflictCommit 'https://github.com/qaworkfree/pi-web-ui' $Snapshot }
catch { $ConflictRejected = $_.Exception.Message -match 'conflict' }
Assert-LauncherTest ($ConflictRejected -and (Get-LauncherSnapshot $Source "$Fixture\source-after-conflict.patch").Fingerprint -eq $Snapshot.Fingerprint) 'Conflicting update is rejected without altering the original checkout'

$Root = $Fixture
New-Item -ItemType Directory -Path "$Fixture\logs" -Force | Out-Null
$TestListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$TestListener.Start()
try {
    $Rejected = $false
    try { Get-LauncherOwnedProcess 'missing-record.json' $TestListener.LocalEndpoint.Port | Out-Null }
    catch { $Rejected = $_.Exception.Message -match 'unrecorded process' }
    Assert-LauncherTest $Rejected 'An unrelated port owner is rejected'
} finally { $TestListener.Stop() }

$LiveFixture = "$Fixture\live-folders"
$Root = $LiveFixture
New-Item -ItemType Directory -Path "$Root\pipipiPopopo","$Root\pi-web-ui","$Root\cache\releases\a\runtime\.git","$Root\cache\releases\a\ui\.git","$Root\cache\releases\b\runtime\.git","$Root\cache\releases\b\ui\.git" -Force | Out-Null
Set-Content -LiteralPath "$Root\pipipiPopopo\old.txt" -Value 'original runtime'
Set-Content -LiteralPath "$Root\pi-web-ui\old.txt" -Value 'original ui'
Set-Content -LiteralPath "$Root\cache\releases\a\ui\live.txt" -Value 'release a'
Set-Content -LiteralPath "$Root\cache\releases\b\ui\live.txt" -Value 'release b'
$ReleaseA = [pscustomobject]@{runtimeRepo="$Root\cache\releases\a\runtime";uiRepo="$Root\cache\releases\a\ui"}
$ReleaseB = [pscustomobject]@{runtimeRepo="$Root\cache\releases\b\runtime";uiRepo="$Root\cache\releases\b\ui"}
$LiveA = Set-LauncherLiveDeployment $ReleaseA
$Backups = @(Get-ChildItem -LiteralPath "$Root\cache\folder-backups" -Recurse -Filter old.txt)
Assert-LauncherTest ($Backups.Count -eq 2 -and $LiveA.uiRepo -eq "$Root\pi-web-ui" -and (Get-Item "$Root\pi-web-ui").LinkType -eq 'Junction') 'Live folders expose the deployment while original folders are backed up'
Set-Content -LiteralPath "$Root\pi-web-ui\live.txt" -Value 'edited through main folder'
Assert-LauncherTest ((Get-Content "$Root\cache\releases\a\ui\live.txt" -Raw).Trim() -eq 'edited through main folder') 'Edits in the main folder modify the actual live release'
Set-LauncherLiveDeployment $ReleaseB | Out-Null
Set-LauncherLiveDeployment $LiveA | Out-Null
Assert-LauncherTest ((Get-Content "$Root\pi-web-ui\live.txt" -Raw).Trim() -eq 'edited through main folder' -and (Get-Content "$Root\cache\releases\b\ui\live.txt" -Raw).Trim() -eq 'release b') 'Promotion and rollback preserve both release directories'
New-Item -ItemType Directory -Path "$Root\logs","$Root\cache\releases\a\runtime\packages\workspace","$Root\cache\releases\a\runtime\node_modules\@fixture" -Force | Out-Null
Set-Content -LiteralPath "$Root\cache\releases\a\runtime\package.json" -Value '{"name":"fixture-root","version":"1.0.0","private":true,"workspaces":["packages/*"]}' -Encoding ASCII
Set-Content -LiteralPath "$Root\cache\releases\a\runtime\packages\workspace\package.json" -Value '{"name":"@fixture/workspace","version":"1.0.0"}' -Encoding ASCII
$WorkspaceLink = "$Root\cache\releases\a\runtime\node_modules\@fixture\workspace"
New-Item -ItemType Junction -Path $WorkspaceLink -Target "$Root\cache\releases\a\runtime\packages\workspace" | Out-Null
Assert-LauncherTest (Test-LauncherDependencies "$Root\pipipiPopopo") 'Workspace dependencies are healthy through the canonical folder junction'
[IO.Directory]::Delete($WorkspaceLink)
Assert-LauncherTest (-not (Test-LauncherDependencies "$Root\pipipiPopopo")) 'Missing workspace dependencies are still rejected through a junction'
New-Item -ItemType Directory -Path "$Root\deployment.pending.json" | Out-Null
$PromotionRejected = $false
try { Set-LauncherLiveDeployment $ReleaseB | Out-Null } catch { $PromotionRejected = $true }
Assert-LauncherTest ($PromotionRejected -and (Get-Content "$Root\pi-web-ui\live.txt" -Raw).Trim() -eq 'edited through main folder') 'Failed manifest write restores the previous live links'
$OutsideRejected = $false
try { Set-LauncherLiveDeployment ([pscustomobject]@{runtimeRepo=$StackRoot;uiRepo=$ReleaseA.uiRepo}) | Out-Null } catch { $OutsideRejected = $_.Exception.Message -match 'Invalid runtime release path' }
Assert-LauncherTest $OutsideRejected 'Release targets outside the managed workspace are rejected'
$Root = $StackRoot
@{passed=$Results.Count;tests=$Results.ToArray();fixture=$Fixture} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$StackRoot\logs\launcher-tests.json"
