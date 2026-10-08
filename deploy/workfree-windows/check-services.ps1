. "$PSScriptRoot\workfree-env.ps1"
$Config = Get-Content -LiteralPath $ServiceConfigPath -Raw | ConvertFrom-Json
foreach ($Service in @(@{Name='Model';Port=$Config.modelPort;Endpoint='/health'},@{Name='UI';Port=$Config.uiPort;Endpoint='/api/health'})) {
    $Url = "http://127.0.0.1:$($Service.Port)"
    $Listener = Get-NetTCPConnection -LocalPort $Service.Port -State Listen -ErrorAction SilentlyContinue
    try { $Body = Invoke-RestMethod ($Url+$Service.Endpoint) -TimeoutSec 3; [pscustomobject]@{Service=$Service.Name;Url=$Url;Pid=$Listener.OwningProcess;Health=$Body} | ConvertTo-Json -Depth 12 } catch { Write-Output "$($Service.Name) unavailable at $Url : $($_.Exception.Message)" }
}
