param([string]$InstallationRoot = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$TaskStorageRoot = [IO.Path]::GetFullPath($InstallationRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath $TaskStorageRoot -PathType Container)) { throw 'Installation folder does not exist.' }
function Get-PrivatePath([string]$Relative) {
    $Resolved = [IO.Path]::GetFullPath((Join-Path $TaskStorageRoot $Relative))
    if (-not $Resolved.StartsWith($TaskStorageRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Storage path escapes the installation folder.' }
    return $Resolved
}
function Assert-PrivateParents([string]$Path) {
    $Ancestor = Split-Path -Parent $Path
    while ($Ancestor -ne $TaskStorageRoot) {
        if (Test-Path -LiteralPath $Ancestor) {
            if ((Get-Item -LiteralPath $Ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Personal storage requires real parent folders: $Ancestor" }
        }
        $Ancestor = Split-Path -Parent $Ancestor
    }
}
$TaskMappings = @(
    @{Old='ui-data';New='Personal\UI'},
    @{Old='agent-config';New='Personal\Agent'},
    @{Old='test-project';New='Personal\Workspace'},
    @{Old='logs';New='Personal\Logs'},
    @{Old='temp';New='Personal\Temp\legacy-install-temp'},
    @{Old='Personal\UI\uploads';New='Personal\Uploads'},
    @{Old='Personal\UI\attachments';New='Personal\Attachments'},
    @{Old='cache\config-backups';New='Personal\Backups\config-backups'},
    @{Old='cache\folder-backups';New='Personal\Backups\folder-backups'},
    @{Old='cache\launcher-backups';New='Personal\Backups\launcher-backups'},
    @{Old='cache\github-publish';New='Personal\Backups\github-publish'}
)
$TaskConfigOld = Get-PrivatePath 'service-config.json'
$TaskConfigNew = Get-PrivatePath 'Personal\Config\service-config.json'
if ((Test-Path -LiteralPath $TaskConfigOld) -and (Test-Path -LiteralPath $TaskConfigNew)) { throw 'Both service configuration locations exist; refusing to overwrite either.' }
Assert-PrivateParents $TaskConfigNew
# Preflight every path before moving anything. Existing data is never merged or overwritten.
foreach ($Map in $TaskMappings) {
    $Old = Get-PrivatePath $Map.Old; $New = Get-PrivatePath $Map.New
    Assert-PrivateParents $New
    if (Test-Path -LiteralPath $Old) {
        $Item = Get-Item -LiteralPath $Old -Force
        if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            if ([IO.Path]::GetFullPath([string]$Item.Target).TrimEnd('\') -ne $New) { throw "Unexpected storage junction: $Old" }
        } elseif (Test-Path -LiteralPath $New) { throw "Both storage locations already exist: $Old and $New" }
    }
}
New-Item -ItemType Directory -Path (Split-Path -Parent $TaskConfigNew) -Force | Out-Null
if (Test-Path -LiteralPath $TaskConfigOld) { Move-Item -LiteralPath $TaskConfigOld -Destination $TaskConfigNew }
foreach ($Map in $TaskMappings) {
    $Old = Get-PrivatePath $Map.Old; $New = Get-PrivatePath $Map.New
    if ((Test-Path -LiteralPath $Old) -and ((Get-Item -LiteralPath $Old -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    New-Item -ItemType Directory -Path (Split-Path -Parent $New) -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $Old) -Force | Out-Null
    $Moved = Test-Path -LiteralPath $Old
    if ($Moved) { Move-Item -LiteralPath $Old -Destination $New }
    else { New-Item -ItemType Directory -Path $New -Force | Out-Null }
    try { New-Item -ItemType Junction -Path $Old -Target $New | Out-Null }
    catch { if ($Moved) { Move-Item -LiteralPath $New -Destination $Old }; throw }
}
# The guard checks both the original path and its real path. Preserve each existing
# rule's permissions at the equivalent physical location, without granting new access.
$TaskPolicyPath = Get-PrivatePath 'Personal\UI\filesystem-policy.json'
if (Test-Path -LiteralPath $TaskPolicyPath) {
    $TaskPolicy = Get-Content -LiteralPath $TaskPolicyPath -Raw | ConvertFrom-Json
    $TaskRules = @($TaskPolicy.rules)
    foreach ($Map in $TaskMappings) {
        foreach ($Rule in @($TaskRules)) {
            $Old = Get-PrivatePath $Map.Old; $New = Get-PrivatePath $Map.New
            if ($Rule.path -eq $Old -or $Rule.path.StartsWith($Old + '\', [StringComparison]::OrdinalIgnoreCase)) {
                $Physical = $New + $Rule.path.Substring($Old.Length)
                if (-not @($TaskRules | Where-Object { $_.path -eq $Physical }).Count) {
                    $Copy = $Rule | ConvertTo-Json -Depth 30 | ConvertFrom-Json
                    $Copy.path = $Physical
                    if ($Copy.PSObject.Properties['id']) { $Copy.id = [guid]::NewGuid().ToString() }
                    $TaskRules += $Copy
                }
            }
        }
    }
    if ($TaskRules.Count -ne @($TaskPolicy.rules).Count) {
        $TaskBackup = Get-PrivatePath 'Personal\Backups\filesystem-policy-before-personal.json'
        if (-not (Test-Path -LiteralPath $TaskBackup)) { Copy-Item -LiteralPath $TaskPolicyPath -Destination $TaskBackup }
        $TaskPolicy.rules = $TaskRules
        [IO.File]::WriteAllText($TaskPolicyPath + '.tmp', ($TaskPolicy | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath ($TaskPolicyPath + '.tmp') -Destination $TaskPolicyPath -Force
    }
}
Write-Host 'Personal storage ready; existing paths remain compatible.'
