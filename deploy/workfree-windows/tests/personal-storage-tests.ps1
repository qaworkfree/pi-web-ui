$ErrorActionPreference = 'Stop'
$TaskSourceRoot = Split-Path -Parent $PSScriptRoot
$TaskFixtures = Join-Path $TaskSourceRoot ('Personal\Temp\personal-fixtures-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TaskFixtures -Force | Out-Null
function Assert-Private([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
$TaskGood = Join-Path $TaskFixtures 'good'
foreach ($Folder in @('ui-data','agent-config','test-project','logs','temp','cache\github-publish')) {
    New-Item -ItemType Directory -Path "$TaskGood\$Folder" -Force | Out-Null
    [IO.File]::WriteAllText("$TaskGood\$Folder\preserved.txt", 'private fixture')
}
$TaskPolicy = @{ defaultPermissions=@{read='block'};rules=@(@{path="$TaskGood\test-project";permissions=@{read='allow';execute='ask'}},@{path="$TaskGood\test-project\restricted";permissions=@{read='block'}}) }
$TaskPolicy | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath "$TaskGood\ui-data\filesystem-policy.json" -Encoding UTF8
New-Item -ItemType Directory -Path "$TaskGood\ui-data\uploads\client","$TaskGood\ui-data\attachments" -Force | Out-Null
[IO.File]::WriteAllText("$TaskGood\ui-data\uploads\client\document.pdf", 'private upload fixture')
[IO.File]::WriteAllText("$TaskGood\ui-data\attachments\saved.json", 'private attachment fixture')
[IO.File]::WriteAllText("$TaskGood\service-config.json", '{"uiPort":8788}')
& "$TaskSourceRoot\prepare-personal-storage.ps1" -InstallationRoot $TaskGood
Assert-Private ((Get-Content -LiteralPath "$TaskGood\Personal\Uploads\client\document.pdf") -eq 'private upload fixture') 'Upload migration lost data'
Assert-Private ((Get-Content -LiteralPath "$TaskGood\Personal\Attachments\saved.json") -eq 'private attachment fixture') 'Attachment migration lost data'
Assert-Private (-not (Test-Path -LiteralPath "$TaskGood\service-config.json")) 'Private service preferences remain outside Personal'
Assert-Private ((Get-Content -LiteralPath "$TaskGood\Personal\Config\service-config.json") -eq '{"uiPort":8788}') 'Private service configuration lost'
foreach ($Folder in @('ui-data','agent-config','test-project','logs','temp','cache\github-publish')) {
    Assert-Private ((Get-Content -LiteralPath "$TaskGood\$Folder\preserved.txt") -eq 'private fixture') 'Original data lost'
    Assert-Private ([bool]((Get-Item -LiteralPath "$TaskGood\$Folder").Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Compatibility alias missing'
}
$TaskMigrated = Get-Content -LiteralPath "$TaskGood\ui-data\filesystem-policy.json" -Raw | ConvertFrom-Json
Assert-Private ($TaskMigrated.rules.Count -eq 4) 'Physical permission equivalents missing'
Assert-Private ($TaskMigrated.rules[2].permissions.execute -eq 'ask') 'Execution permission changed'
Assert-Private ($TaskMigrated.rules[3].permissions.read -eq 'block') 'Specific blocked rule lost'
Assert-Private ($TaskMigrated.defaultPermissions.read -eq 'block') 'Default policy changed'
& "$TaskSourceRoot\prepare-personal-storage.ps1" -InstallationRoot $TaskGood
$TaskRepeated = Get-Content -LiteralPath "$TaskGood\ui-data\filesystem-policy.json" -Raw | ConvertFrom-Json
Assert-Private ($TaskRepeated.rules.Count -eq 4) 'Repeated migration duplicated rules'
$TaskConflict = Join-Path $TaskFixtures 'conflict'
New-Item -ItemType Directory -Path "$TaskConflict\ui-data","$TaskConflict\Personal\UI" -Force | Out-Null
$TaskRejected = $false
try { & "$TaskSourceRoot\prepare-personal-storage.ps1" -InstallationRoot $TaskConflict } catch { $TaskRejected = $true }
Assert-Private $TaskRejected 'Existing destination should reject migration'
Assert-Private (-not ((Get-Item -LiteralPath "$TaskConflict\ui-data").Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Failed preflight mutated source'
$TaskExternal = Join-Path $TaskFixtures 'external'
New-Item -ItemType Directory -Path $TaskExternal -Force | Out-Null
New-Item -ItemType Junction -Path "$TaskExternal\Personal" -Target $TaskGood | Out-Null
$TaskRejected = $false
try { & "$TaskSourceRoot\prepare-personal-storage.ps1" -InstallationRoot $TaskExternal } catch { $TaskRejected = $true }
Assert-Private $TaskRejected 'External Personal target should reject migration'
Write-Output 'Personal storage: preservation, aliases, permission equivalence, idempotency and conflict/external-path rejection passed.'
