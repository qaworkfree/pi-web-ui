. "$PSScriptRoot\workfree-env.ps1"
Set-Location -LiteralPath $env:PI_UI_REPO
Invoke-CheckedNpm -CommandArgs @('ci','--ignore-scripts') -LogName 'ui-npm-ci.log'
Invoke-CheckedNpm -CommandArgs @('rebuild','node-pty') -LogName 'ui-node-pty.log'
foreach ($TaskName in @('typecheck','build:server','build:web','build:dsh-runtime','build:mermaid-vendor','build:runtrace-vendor')) {
    Invoke-CheckedNpm -CommandArgs @('run',$TaskName) -LogName ('ui-'+$TaskName.Replace(':','-')+'.log')
}
