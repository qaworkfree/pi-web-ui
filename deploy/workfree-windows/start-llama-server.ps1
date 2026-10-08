. "$PSScriptRoot\workfree-env.ps1"
$Config = Get-Content -LiteralPath $ServiceConfigPath -Raw | ConvertFrom-Json
$Listener = Get-NetTCPConnection -LocalPort $Config.modelPort -State Listen -ErrorAction SilentlyContinue
if ($Listener) { throw "Port $($Config.modelPort) is already occupied (PID $($Listener.OwningProcess)). Run check-services.ps1." }
if (-not (Test-Path -LiteralPath $Config.modelsDir -PathType Container)) { throw "Model folder not found: $($Config.modelsDir)" }
$ProfilePath = "$Root\ui-data\local-launcher\profiles.json"
$RuntimePath = (Get-Item -LiteralPath $env:PI_RUNTIME_REPO).Target
if (-not $RuntimePath) { $RuntimePath = $env:PI_RUNTIME_REPO }
& "$NodeDir\node.exe" "$RuntimePath\scripts\local-model-profiles.mjs" prepare $ProfilePath $Config.modelsDir | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare GGUF model profiles.' }
$Profiles = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json
$ServerArgs = '--models-preset "{0}" --models-max 1 --models-autoload --jinja --host 127.0.0.1 --port {1} --parallel 1 --n-gpu-layers 0 --threads {2} --no-repack' -f $Profiles.presetPath,$Config.modelPort,$Config.threads
# Inherited single-model flags must not override router/preset settings.
Get-ChildItem Env: | Where-Object Name -Like 'LLAMA_ARG_*' | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$ServerProcess = Start-Process -FilePath $Config.llamaExe -ArgumentList $ServerArgs -WorkingDirectory (Split-Path -Parent $Config.llamaExe) -WindowStyle Hidden -RedirectStandardOutput "$Root\logs\llama-server.log" -RedirectStandardError "$Root\logs\llama-server.err.log" -PassThru
[pscustomobject]@{Pid=$ServerProcess.Id;Exe=$Config.llamaExe;StartedUtc=$ServerProcess.StartTime.ToUniversalTime().ToString('o');Port=$Config.modelPort} | ConvertTo-Json | Set-Content -LiteralPath "$Root\logs\llama-process.json"
Write-Output "Started llama.cpp router PID $($ServerProcess.Id): $($Profiles.models.Count) models available, none loaded until requested."
