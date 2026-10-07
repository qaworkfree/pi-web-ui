. "$PSScriptRoot\workfree-env.ps1"
foreach ($ProcessRecord in @('llama-process.json','ui-process.json')) {
    $RecordPath = "$Root\logs\$ProcessRecord"
    if (-not (Test-Path -LiteralPath $RecordPath)) { continue }
    $Record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
    $OwnedProcess = Get-Process -Id $Record.Pid -ErrorAction SilentlyContinue
    if (-not $OwnedProcess) { continue }
    if ($OwnedProcess.Path -ne $Record.Exe -or $OwnedProcess.StartTime.ToUniversalTime() -ne ([datetime]$Record.StartedUtc).ToUniversalTime()) { throw "PID $($Record.Pid) no longer matches our recorded process; refusing to stop it." }
    & taskkill.exe /PID $OwnedProcess.Id /T /F
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $OwnedProcess.Id -ErrorAction SilentlyContinue)) { throw "Could not stop recorded service PID $($OwnedProcess.Id)" }
    Write-Output "Stopped owned service tree PID $($OwnedProcess.Id)"
}
