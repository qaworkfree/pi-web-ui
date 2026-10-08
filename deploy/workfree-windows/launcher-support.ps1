$ErrorActionPreference = 'Stop'

function Invoke-LauncherGit {
    param([string]$Repo, [string[]]$Arguments)
    $SavedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Output = & git -C $Repo @Arguments 2>&1
        $Code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $SavedPreference }
    if ($Code -ne 0) { throw "Git $($Arguments -join ' ') failed in ${Repo}: $($Output -join [Environment]::NewLine)" }
    return ($Output | ForEach-Object { "$_" })
}

function Get-LauncherSnapshot {
    param([string]$Repo, [string]$PatchPath)
    $HeadCommit = (Invoke-LauncherGit $Repo @('rev-parse','HEAD')).Trim()
    Invoke-LauncherGit $Repo @('diff','--binary',"--output=$PatchPath",'HEAD') | Out-Null
    $Untracked = @(Invoke-LauncherGit $Repo @('-c','core.quotepath=false','ls-files','--others','--exclude-standard'))
    $Parts = @($HeadCommit, (Get-FileHash -LiteralPath $PatchPath -Algorithm SHA256).Hash)
    foreach ($RelativePath in $Untracked) {
        $FullPath = [IO.Path]::GetFullPath((Join-Path $Repo $RelativePath))
        if (-not $FullPath.StartsWith([IO.Path]::GetFullPath($Repo).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Invalid untracked path in $Repo"
        }
        if ((Get-Item -LiteralPath $FullPath).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Untracked links need manual review: $RelativePath"
        }
        $Parts += "$RelativePath=$((Get-FileHash -LiteralPath $FullPath -Algorithm SHA256).Hash)"
    }
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { $Fingerprint = [BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes(($Parts -join "`n")))).Replace('-','') }
    finally { $Hasher.Dispose() }
    [pscustomobject]@{Head=$HeadCommit; Fingerprint=$Fingerprint; Patch=$PatchPath; Untracked=$Untracked}
}

function Test-LauncherDependencies {
    param([string]$Repo)
    # npm compares workspace links against its current directory. Use the
    # physical checkout when the public live folder is a directory junction.
    $RepoItem = Get-Item -LiteralPath $Repo
    if ($RepoItem.LinkType -eq 'Junction') { $Repo = [string](@($RepoItem.Target)[0]) }
    Push-Location -LiteralPath $Repo
    $SavedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & "$NodeDir\npm.cmd" ls --depth=0 --json 1> "$Root\logs\launcher-dependencies.json" 2> "$Root\logs\launcher-dependencies.err.log"
        return ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $SavedPreference; Pop-Location }
}

function Get-LauncherOwnedProcess {
    param([string]$RecordName, [int]$Port)
    $Listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $RecordPath = "$Root\logs\$RecordName"
    $OwnedProcess = $null
    if (Test-Path -LiteralPath $RecordPath) {
        $Record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
        $CandidateProcess = Get-Process -Id $Record.Pid -ErrorAction SilentlyContinue
        if ($CandidateProcess -and $CandidateProcess.Path -eq $Record.Exe -and
            $CandidateProcess.StartTime.ToUniversalTime().Ticks -eq ([datetime]$Record.StartedUtc).ToUniversalTime().Ticks -and
            [int]$Record.Port -eq $Port) { $OwnedProcess = $CandidateProcess }
    }
    foreach ($Listener in $Listeners) {
        if (-not $OwnedProcess -or $Listener.OwningProcess -ne $OwnedProcess.Id) {
            throw "Port $Port is occupied by an unrecorded process (PID $($Listener.OwningProcess)). Run the launcher to replace listeners on its configured ports."
        }
    }
    return $OwnedProcess
}

function Wait-LauncherHealth {
    param([string]$Url, [string]$RecordName, [int]$Port, [int]$TimeoutSeconds = 180)
    $Deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (-not (Get-LauncherOwnedProcess $RecordName $Port)) { throw "Service exited while starting. Check logs\$RecordName and the service error log." }
        try {
            $Response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            if ($Response.status -eq 'ok' -or $Response.ok -eq $true) { return }
        } catch { }
        Start-Sleep -Seconds 1
    } while ([datetime]::UtcNow -lt $Deadline)
    throw "Service did not become healthy within $TimeoutSeconds seconds: $Url"
}

function New-LauncherCandidate {
    param([string]$Source, [string]$Destination, [string]$Commit, [string]$Remote, $Snapshot, [switch]$GitHubOnly)
    $CloneSource = if ($GitHubOnly) { $Remote } else { $Source }
    Invoke-LauncherGit $Root @('clone','--no-hardlinks','--no-checkout',$CloneSource,$Destination) | Out-Null
    # Configure the empty candidate before checkout to preserve formatter LF endings.
    Invoke-LauncherGit $Destination @('config','core.autocrlf','false') | Out-Null
    Invoke-LauncherGit $Destination @('remote','set-url','origin',$Remote) | Out-Null
    Invoke-LauncherGit $Destination @('checkout','--detach',$Commit) | Out-Null
    if ($GitHubOnly) { return }
    if ((Get-Item -LiteralPath $Snapshot.Patch).Length -gt 0) {
        Invoke-LauncherGit $Destination @('apply','--3way',$Snapshot.Patch) | Out-Null
    }
    foreach ($RelativePath in $Snapshot.Untracked) {
        $Target = [IO.Path]::GetFullPath((Join-Path $Destination $RelativePath))
        if (-not $Target.StartsWith([IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid candidate file path.' }
        if (Test-Path -LiteralPath $Target) {
            # Publishing a local file can make it tracked upstream. Compare Git's
            # normalized content so Windows line endings do not cause a conflict.
            $LocalBlob = (Invoke-LauncherGit $Destination @('-c','core.autocrlf=true','hash-object',"--path=$RelativePath",(Join-Path $Source $RelativePath))).Trim()
            $TargetBlob = (Invoke-LauncherGit $Destination @('-c','core.autocrlf=true','hash-object',"--path=$RelativePath",$Target)).Trim()
            if ($LocalBlob -eq $TargetBlob) { continue }
            throw "Update now tracks a different version of a locally added file: $RelativePath. Resolve this manually."
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $Source $RelativePath) -Destination $Target
    }
}

function Invoke-LauncherBuild {
    param([string]$Repo, [string]$Kind)
    Write-Host "Installing $Kind dependencies from package-lock.json (npm cache enabled)..."
    Push-Location -LiteralPath $Repo
    try {
        & "$NodeDir\node.exe" -e "const semver=require(process.argv[1]);const p=require('./package.json');if(p.engines?.node&&!semver.satisfies(process.version,p.engines.node)){console.error('Node.js '+p.engines.node+' is required by this update.');process.exit(1)}" "$NodeDir\node_modules\npm\node_modules\semver"
        if ($LASTEXITCODE -ne 0) { throw "The $Kind update requires a different Node.js version." }
        Invoke-CheckedNpm @('ci','--ignore-scripts','--include=dev','--no-audit','--no-fund') "launcher-$Kind-install.log"
        if ($Kind -eq 'runtime') {
            $Tasks = @('hydrate:model-data','check:model-data','build:offline')
        } else {
            # Prefer the shipped native binary; compile only when it cannot load.
            $SavedPreference = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & "$NodeDir\node.exe" -e "require('node-pty/lib/utils').loadNativeModule('conpty')" 2> "$Root\logs\launcher-node-pty.log"
                $NativeResult = $LASTEXITCODE
            } finally { $ErrorActionPreference = $SavedPreference }
            if ($NativeResult -ne 0) { Invoke-CheckedNpm @('rebuild','node-pty') 'launcher-node-pty-rebuild.log' }
            $Tasks = @('typecheck','build:server','build:web','build:dsh-runtime','build:mermaid-vendor','build:runtrace-vendor')
        }
        foreach ($Task in $Tasks) {
            Write-Host "Building ${Kind}: $Task"
            Invoke-CheckedNpm @('run',$Task) "launcher-$Kind-$($Task.Replace(':','-')).log"
        }
        if (-not (Test-LauncherDependencies $Repo)) { throw "The $Kind dependency check failed after installation." }
    } finally { Pop-Location }
}

function Set-LauncherDeployment {
    param($Value)
    $Path = "$Root\deployment.json"
    $Pending = "$Root\deployment.pending.json"
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Pending -Encoding UTF8
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($Pending, $Path, "$Root\deployment.previous.json") }
    else { [IO.File]::Move($Pending, $Path) }
}

function Set-LauncherLiveDeployment {
    param($Value)
    # Keep the user-facing folders attached to the exact deployed files. Release
    # directories stay in place so npm workspace links and rollback remain valid.
    $Workspace = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $ReleasePrefix = "$Workspace\cache\releases\"
    $Plans = @()
    $Next = [ordered]@{}
    foreach ($Property in $Value.PSObject.Properties) { $Next[$Property.Name] = $Property.Value }
    foreach ($Kind in @('runtime','ui')) {
        $Release = $Value.($Kind + 'Release')
        if (-not $Release) { $Release = $Value.($Kind + 'Repo') }
        $Release = [IO.Path]::GetFullPath($Release).TrimEnd('\')
        if (-not $Release.StartsWith($ReleasePrefix,[StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath "$Release\.git")) { throw "Invalid $Kind release path: $Release" }
        $Name = if ($Kind -eq 'runtime') { 'pipipiPopopo' } else { 'pi-web-ui' }
        $Live = [IO.Path]::GetFullPath((Join-Path $Workspace $Name))
        $PreviousTarget = $null
        $Item = Get-Item -LiteralPath $Live -Force -ErrorAction SilentlyContinue
        if ($Item -and ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            $PreviousTarget = [IO.Path]::GetFullPath([string](@($Item.Target)[0])).TrimEnd('\')
            if ($Item.LinkType -ne 'Junction' -or -not $PreviousTarget.StartsWith($ReleasePrefix,[StringComparison]::OrdinalIgnoreCase)) {
                throw "Unmanaged link at $Live; refusing to replace it."
            }
        }
        $Plans += [pscustomobject]@{Kind=$Kind;Live=$Live;Release=$Release;PreviousTarget=$PreviousTarget;Existed=[bool]$Item;Backup=$null;Changed=$false}
        $Next[$Kind + 'Repo'] = $Live
        $Next[$Kind + 'Release'] = $Release
    }
    $Next['liveFolders'] = $true
    $BackupRoot = "$Workspace\cache\folder-backups\$([datetime]::UtcNow.ToString('yyyyMMdd-HHmmss'))-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    try {
        foreach ($Plan in $Plans) {
            if ($Plan.PreviousTarget -eq $Plan.Release) { continue }
            if ($Plan.PreviousTarget) {
                # Non-recursive removal of our junction only; target files remain.
                [IO.Directory]::Delete($Plan.Live)
            } elseif ($Plan.Existed) {
                $Backup = [IO.Path]::GetFullPath((Join-Path $BackupRoot (Split-Path -Leaf $Plan.Live)))
                if (-not $Backup.StartsWith("$Workspace\cache\folder-backups\",[StringComparison]::OrdinalIgnoreCase) -or
                    $Plan.Live -notin @("$Workspace\pipipiPopopo","$Workspace\pi-web-ui")) { throw 'Backup move escaped the managed workspace.' }
                New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
                Move-Item -LiteralPath $Plan.Live -Destination $Backup
                $Plan.Backup = $Backup
                Write-Host "Previous folder retained: $Backup"
            }
            $Plan.Changed = $true
            New-Item -ItemType Junction -Path $Plan.Live -Target $Plan.Release | Out-Null
            Write-Host "Live folder: $($Plan.Live) -> $($Plan.Release)"
        }
        Set-LauncherDeployment ([pscustomobject]$Next)
    } catch {
        # Restore every already-changed path, including failure between the two links.
        for ($Index = $Plans.Count - 1; $Index -ge 0; $Index--) {
            $Plan = $Plans[$Index]
            if (-not $Plan.Changed) { continue }
            $Current = Get-Item -LiteralPath $Plan.Live -Force -ErrorAction SilentlyContinue
            if ($Current) {
                if ($Current.LinkType -ne 'Junction' -or
                    [IO.Path]::GetFullPath([string](@($Current.Target)[0])).TrimEnd('\') -ne $Plan.Release) { throw "Unexpected path during rollback: $($Plan.Live)" }
                [IO.Directory]::Delete($Plan.Live)
            }
            if ($Plan.Backup) {
                if (-not [IO.Path]::GetFullPath($Plan.Backup).StartsWith("$Workspace\cache\folder-backups\",[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid rollback backup path.' }
                Move-Item -LiteralPath $Plan.Backup -Destination $Plan.Live
            } elseif ($Plan.PreviousTarget) {
                New-Item -ItemType Junction -Path $Plan.Live -Target $Plan.PreviousTarget | Out-Null
            }
        }
        throw
    }
    return [pscustomobject]$Next
}

function Invoke-LauncherUiControl {
    param([int]$Port, [string]$Command)
    $SavedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $Output = & "$NodeDir\node.exe" "$Root\launcher-ui-control.cjs" $Port $Command 2>&1
        $Code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $SavedPreference }
    if ($Code -ne 0 -or -not $Output) { throw "UI control failed: $Output" }
    return ($Output -join "`n" | ConvertFrom-Json)
}

function Test-LauncherUiCanRestart {
    param([int]$Port, [int]$ExpectedPid)
    $Quiesced = $false
    try {
        $Status = Invoke-LauncherUiControl $Port 'status'
        if ($Status.pid -ne $ExpectedPid) { throw 'UI control PID did not match the recorded server.' }
        if ($Status.activeConversations -gt 0 -or $Status.pendingMessages -gt 0) { throw 'The UI has active or queued work.' }
        Invoke-LauncherUiControl $Port 'quiesce' | Out-Null
        $Quiesced = $true
        $Status = Invoke-LauncherUiControl $Port 'status'
        if ($Status.activeConversations -gt 0 -or $Status.pendingMessages -gt 0) { throw 'The UI has active or queued work.' }
        return $true
    } catch {
        if ($Quiesced) { Invoke-LauncherUiControl $Port 'unquiesce' | Out-Null }
        Write-Warning "Update built but restart postponed: $($_.Exception.Message) Run the launcher again when the UI is idle."
        return $false
    }
}
