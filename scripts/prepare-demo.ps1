param([string]$Destination = '.demo/flask')
$ErrorActionPreference = 'Stop'
$commit = '22d924701a6ae2e4cd01e9a15bbaf3946094af65'
if (Test-Path -LiteralPath $Destination) {
    $head = & git -C $Destination rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $head -ne $commit) {
        throw 'The destination exists at another revision. Choose a new destination or inspect it manually.'
    }
    $changes = & git -C $Destination status --porcelain
    if ($LASTEXITCODE -ne 0 -or $changes) {
        throw 'The demo checkout contains changes. Preserve them and choose a new destination for a clean demo.'
    }
} else {
    & git clone --branch 3.1.3 --depth 1 https://github.com/pallets/flask.git $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Flask clone failed.' }
    $head = & git -C $Destination rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $head -ne $commit) { throw 'Unexpected Flask revision.' }
}
Write-Host "Flask 3.1.3 ready at $Destination ($commit)."
Write-Host 'Install Flask and its test dependencies into your Python environment before recording.'
Write-Host 'From the Flask folder, run python -m pip install -e ".[dotenv]" pytest pytest-asyncio asgiref.'
Write-Host 'Then follow submission/DEMO_SCRIPT.md. This script preserves existing changes.'
