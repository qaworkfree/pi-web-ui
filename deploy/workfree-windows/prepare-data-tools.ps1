. "$PSScriptRoot\workfree-env.ps1"
$PythonEnv = "$Root\tools\python"
$PythonExe = "$PythonEnv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $PythonExe)) {
    $ExistingPython = Get-Command python -ErrorAction SilentlyContinue
    if (-not $ExistingPython) { throw 'Python 3.11+ is required for document creation/data tools. Install Python, then run the launcher.' }
    Write-Host 'Preparing an isolated Python environment for document/data tools...'
    & $ExistingPython.Source -m venv $PythonEnv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the document/data Python environment.' }
}
$CheckScript = @'
import importlib.metadata, pathlib, sys
requirements = pathlib.Path(sys.argv[1]).read_text().splitlines()
try:
    ok = all(importlib.metadata.version(name) == version for name, version in (line.split('==') for line in requirements if line.strip()))
except importlib.metadata.PackageNotFoundError:
    ok = False
sys.exit(0 if ok else 1)
'@
& $PythonExe -c $CheckScript "$Root\tools-requirements.txt"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Installing pinned PDF, Word, PowerPoint, spreadsheet and chart dependencies...'
    & $PythonExe -m pip install --require-virtualenv --disable-pip-version-check -r "$Root\tools-requirements.txt" 1> "$Root\logs\data-tools-install.log" 2> "$Root\logs\data-tools-install.err.log"
    if ($LASTEXITCODE -ne 0) { throw 'Document/data dependency installation failed. See logs\data-tools-install.err.log.' }
}
$env:PATH = "$PythonEnv\Scripts;" + $env:PATH
& $PythonExe -c "import json, importlib.metadata; import reportlab, docx, pptx, openpyxl, matplotlib, pandas, ddgs; print(json.dumps({'ready':True, 'packages':{p:importlib.metadata.version(p) for p in ['reportlab','python-docx','python-pptx','openpyxl','matplotlib','pandas','ddgs']}}))" 1> "$Root\logs\data-tools.json"
if ($LASTEXITCODE -ne 0) { throw 'Document/data dependencies could not load.' }
Write-Host 'Python tools ready for PDF/Word/PowerPoint/Excel creation, data analysis and charts.'
