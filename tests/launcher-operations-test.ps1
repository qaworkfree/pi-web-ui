# Cross-platform PowerShell harness for actual launcher functions. Windows cmdlets are mocked.
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
foreach ($Script in @('start-workfree-local.ps1', 'workfree-launcher-functions.ps1')) {
    $ParseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $Repo "scripts/$Script"), [ref]$null, [ref]$ParseErrors)
    if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
}
. (Join-Path $Repo 'scripts/workfree-launcher-functions.ps1')
$script:Processes = @{}
$script:Listeners = @()
$script:Killed = @()
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    $ProcessId = [int]($Filter -replace '^ProcessId=', '')
    if ($ProcessId -eq $PID) { return [pscustomobject]@{ ProcessId = $PID; ParentProcessId = 0 } }
    return $script:Processes[$ProcessId]
}
function Get-NetTCPConnection { param($State, $ErrorAction, $ErrorVariable); return $script:Listeners }
function Start-Sleep { param($Milliseconds) }
function taskkill.exe {
    $Target = [int]$args[1]
    $script:Killed += $Target
    $script:Listeners = @($script:Listeners | Where-Object {
        $_.OwningProcess -ne $Target -and $script:Processes[$_.OwningProcess].ParentProcessId -ne $Target
    })
    $global:LASTEXITCODE = 0
}
function Assert-Equal($Actual, $Expected, $Message) {
    if (($Actual | ConvertTo-Json -Compress) -ne ($Expected | ConvertTo-Json -Compress)) { throw $Message }
}
function Listener($Port, $Owner) { return [pscustomobject]@{ LocalPort = $Port; OwningProcess = $Owner } }
$script:Processes[101] = [pscustomobject]@{ ProcessId = 101; ParentProcessId = 0; Name = 'llama-server.exe' }
$script:Processes[102] = [pscustomobject]@{ ProcessId = 102; ParentProcessId = 0; Name = 'node.exe' }
$script:Processes[103] = [pscustomobject]@{ ProcessId = 103; ParentProcessId = 0; Name = 'other.exe' }
$script:Listeners = @((Listener 8080 101), (Listener 8788 102), (Listener 9999 103))
Stop-WorkfreePortListeners @(8080, 8788)
Assert-Equal $script:Killed @(101, 102) 'Must terminate both configured listeners only'
Assert-Equal @($script:Listeners.LocalPort) @(9999) 'Unrelated port must survive'
Stop-WorkfreePortListeners @(8080, 8788)
Assert-Equal $script:Killed @(101, 102) 'Free ports must cause no termination'
$script:Listeners = @((Listener 8080 $PID))
$Rejected = $false
try { Stop-WorkfreePortListeners @(8080) } catch { $Rejected = $_.Exception.Message -match 'protected' }
if (-not $Rejected) { throw 'Own launcher PID must be protected' }
$script:Processes[104] = [pscustomobject]@{ ProcessId = 104; ParentProcessId = 105; Name = 'node.exe' }
$script:Processes[105] = [pscustomobject]@{ ProcessId = 105; ParentProcessId = 0; Name = 'powershell.exe'; CommandLine = '-File "C:\Users\Luiz\AppData\Roaming\pi-web-ui\pi-web-ui.ps1"' }
$script:Killed = @(); $script:Listeners = @((Listener 8788 104))
Stop-WorkfreePortListeners @(8788)
Assert-Equal $script:Killed @(105) 'Known watchdog must stop with its listening child'
$script:Processes[105].CommandLine = '-File "C:\unrelated.ps1"'
$script:Killed = @(); $script:Listeners = @((Listener 8788 104))
Stop-WorkfreePortListeners @(8788)
Assert-Equal $script:Killed @(104) 'Ordinary parent shell must survive'
# Exercise fingerprint against the actual checkout, including paths with spaces.
$Fingerprint = Get-WorkfreeBuildFingerprint $Repo
if ($Fingerprint -notmatch '^[a-f0-9]{64}$') { throw 'Invalid build fingerprint' }
Assert-Equal (Get-WorkfreeBuildFingerprint $Repo) $Fingerprint 'Fingerprint must be repeatable'
Write-Host 'PASS: PowerShell syntax, selected-port cleanup, unrelated ports, PID protection, watchdog handling, build fingerprint.'
