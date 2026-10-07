. "$PSScriptRoot\workfree-env.ps1"
Set-Location -LiteralPath $env:PI_RUNTIME_REPO
Invoke-CheckedNpm -CommandArgs @('ci','--ignore-scripts') -LogName 'runtime-npm-ci.log'
Invoke-CheckedNpm -CommandArgs @('run','hydrate:model-data') -LogName 'runtime-hydrate.log'
Invoke-CheckedNpm -CommandArgs @('run','check:model-data') -LogName 'runtime-model-check.log'
Invoke-CheckedNpm -CommandArgs @('run','build:offline') -LogName 'runtime-build.log'
