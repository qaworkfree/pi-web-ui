# Metadata-only verification: never sends prompts, runs tools or loads weights.
. "$PSScriptRoot\workfree-env.ps1"
$Config = Get-Content -LiteralPath $ServiceConfigPath -Raw | ConvertFrom-Json
$Profiles = Get-Content -LiteralPath "$Root\ui-data\local-launcher\profiles.json" -Raw | ConvertFrom-Json
$BaseUrl = "http://127.0.0.1:$($Config.modelPort)"
$Props = Invoke-RestMethod "$BaseUrl/props" -TimeoutSec 5
$Catalog = Invoke-RestMethod "$BaseUrl/models" -TimeoutSec 5
if ($Props.role -ne 'router' -or $Props.models_autoload -ne $true) { throw 'Expected the local multi-model router with autoload enabled.' }
if (@(Compare-Object @($Profiles.models.id) @($Catalog.data.id)).Count) { throw 'Router catalog does not match the GGUF profiles. Run the launcher.' }
$Checks = foreach ($Model in $Profiles.models) {
    $Entry = $Catalog.data | Where-Object id -eq $Model.id
    $Index = [array]::IndexOf($Entry.status.args, '--ctx-size')
    if ($Index -lt 0 -or [int]$Entry.status.args[$Index+1] -ne $Model.contextWindow -or
        $Model.contextWindow -gt $Model.contextLimit -or $Model.maxTokens -ge $Model.contextWindow) {
        throw "Context mismatch for $($Model.id). Refresh the model list or restart the launcher."
    }
    [pscustomobject]@{Model=$Model.name;Status=$Entry.status.value;Context=$Model.contextWindow;Limit=$Model.contextLimit;MaxOutput=$Model.maxTokens;Embedding=[bool]$Model.embedding}
}
$Checks | Format-Table -AutoSize
@{Pass=$true;Count=$Checks.Count;Models=@($Checks)} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$Root\logs\model-validation.json"
