param([string]$UiRepo = "$PSScriptRoot\pi-web-ui")
. "$PSScriptRoot\workfree-env.ps1"
$WorkerPath = Join-Path $UiRepo 'dist\server\document-worker.js'
if (-not (Test-Path -LiteralPath $WorkerPath)) { throw 'Document/OCR tools were not built. Run the launcher with -Repair.' }
$env:PI_WEB_OCR_CACHE = "$Root\ui-data\ocr-languages"
Write-Host 'Checking local PDF, Office and English/Portuguese OCR tools...'
# This warms only OCR language data; it never loads or prompts a GGUF model.
& "$NodeDir\node.exe" $WorkerPath --prepare 1 1 auto $env:PI_WEB_OCR_CACHE 1> "$Root\logs\document-tools.json" 2> "$Root\logs\document-tools.err.log"
if ($LASTEXITCODE -ne 0) { throw 'Document/OCR preparation failed. See logs\document-tools.err.log.' }
Write-Host 'Document tools ready. OCR works offline after this preparation.'
