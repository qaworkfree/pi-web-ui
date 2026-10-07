$ErrorActionPreference = 'Stop'
$StackRoot = Split-Path -Parent $PSScriptRoot
. "$StackRoot\workfree-env.ps1"
. "$StackRoot\port-listeners.ps1"
$Fixture = "$StackRoot\temp\port-tests-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Fixture -Force | Out-Null
@'
const fs = require('node:fs');
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(server.address().port)));
'@ | Set-Content -LiteralPath "$Fixture\listener.cjs" -Encoding ASCII
$Processes = @()
try {
    foreach ($Name in @('target','neighbor')) {
        $Processes += Start-Process -FilePath "$NodeDir\node.exe" -ArgumentList "`"$Fixture\listener.cjs`" `"$Fixture\$Name.txt`"" -WindowStyle Hidden -PassThru
        for ($Attempt=0; $Attempt -lt 30 -and -not (Test-Path "$Fixture\$Name.txt"); $Attempt++) { Start-Sleep -Milliseconds 100 }
    }
    $SelectedPort = [int](Get-Content "$Fixture\target.txt")
    $OtherPort = [int](Get-Content "$Fixture\neighbor.txt")
    if ($SelectedPort -lt 8900 -or $OtherPort -lt 8900) { throw 'Test ports must be >=8900' }
    Stop-WorkfreePortListeners @($SelectedPort)
    if (Get-Process -Id $Processes[0].Id -ErrorAction SilentlyContinue) { throw 'Selected listener was not stopped' }
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $OtherPort -ErrorAction SilentlyContinue)) { throw 'Unselected listener was affected' }
    Write-Host 'PASS: selected unrelated listener is replaced; neighboring listener survives'
    Stop-WorkfreePortListeners @($SelectedPort)
    Write-Host 'PASS: already free port is accepted'
    $OwnListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $OwnListener.Start()
    try {
        $Rejected = $false
        try { Stop-WorkfreePortListeners @($OwnListener.LocalEndpoint.Port) } catch { $Rejected = $_.Exception.Message -match 'protected' }
        if (-not $Rejected) { throw 'Launcher process must be protected' }
        Write-Host 'PASS: launcher process cannot kill itself'
    } finally { $OwnListener.Stop() }
} finally {
    foreach ($Process in $Processes) {
        if (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $Process.Id -Force }
    }
}
