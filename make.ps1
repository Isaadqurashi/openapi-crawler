# PowerShell helpers for OpenAPI Catalog (Windows)
# Usage: . .\make.ps1

$ProjectRoot = $PSScriptRoot

function Invoke-Install {
    Set-Location $ProjectRoot
    pip install -r requirements.txt
}

function Invoke-Test {
    Set-Location $ProjectRoot
    python -m unittest discover -s tests -v
}

function Invoke-Run {
    Set-Location $ProjectRoot
    if (Test-Path .\.venv\Scripts\Activate.ps1) { . .\.venv\Scripts\Activate.ps1 }
    $line = Get-Content .env -ErrorAction SilentlyContinue | Where-Object {
        $_ -match '^\s*GITHUB_TOKEN=(.+)$' -and $_ -notmatch '^\s*#'
    }
    if ($line -match 'GITHUB_TOKEN=(.+)$') { $env:GITHUB_TOKEN = $matches[1].Trim() }
    python -m src.main @args
}

function Invoke-Report {
    Set-Location $ProjectRoot
    if (Test-Path .\.venv\Scripts\Activate.ps1) { . .\.venv\Scripts\Activate.ps1 }
    python -m tools.render_report
}

function Invoke-Verify {
    Set-Location $ProjectRoot
    if (Test-Path .\.venv\Scripts\Activate.ps1) { . .\.venv\Scripts\Activate.ps1 }
    python verify.py
}

Write-Host "Loaded: Invoke-Install, Invoke-Test, Invoke-Run, Invoke-Report, Invoke-Verify"
