# scripts/dev.ps1 — the Windows counterpart of scripts/dev.sh.
#
#   .\scripts\dev.ps1              # set everything up and start the server
#   .\scripts\dev.ps1 -Demo        # …and seed a demo class (owner1 / stu1)
#   .\scripts\dev.ps1 -SetupOnly   # install + migrate, do not start a server
#   .\scripts\dev.ps1 -Port 9000   # a different port
#
# Safe to re-run.  If PowerShell refuses to run scripts, use:
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1
$ErrorActionPreference = 'Stop'

[CmdletBinding()]
param(
    [switch]$Demo,
    [switch]$SetupOnly,
    [int]$Port = 8000
)

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

function Info($message) { Write-Host "> $message" -ForegroundColor Cyan }
function Warn($message) { Write-Host "! $message" -ForegroundColor Yellow }

# ---------------------------------------------------------------- python
$Python = $null
foreach ($candidate in @('py', 'python')) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) {
        $ok = & $candidate -c "import sys; print(1 if sys.version_info[:2] >= (3, 11) else 0)" 2>$null
        if ($ok -eq '1') { $Python = $candidate; break }
    }
}
if (-not $Python) { throw 'Python 3.11+ not found. Install it from python.org, then run this again.' }

# ---------------------------------------------------------------- venv
$VenvPy = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $VenvPy)) {
    Info 'creating the virtualenv (.venv)'
    & $Python -m venv .venv
}
if (-not (& $VenvPy -c 'import django' 2>$null)) {
    Info 'installing requirements (one time, ~30 s)'
    & $VenvPy -m pip install --quiet --upgrade pip
    & $VenvPy -m pip install --quiet -r requirements.txt
}

# ---------------------------------------------------------------- .env
$EnvFile = Join-Path $Root '.env'
if (-not (Test-Path $EnvFile)) {
    Info 'creating .env from .env.example (with a fresh SECRET_KEY)'
    Copy-Item .env.example .env
    $secret = & $VenvPy -c 'from django.core.management.utils import get_random_secret_key as k; print(k())'
    (Get-Content .env) -replace '^SECRET_KEY=.*', "SECRET_KEY=$secret" | Set-Content .env
}

# ---------------------------------------------------------------- database
Info 'applying migrations'
& $VenvPy manage.py migrate --noinput | Out-Null

# `migrate` exits 0 even when a migration could not be applied; an outdated
# schema then shows up as a WebSocket that connects and dies, which reads as
# "the whiteboard is broken".
& $VenvPy manage.py migrate --check --noinput 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "The database still has unapplied migrations. Run '$VenvPy manage.py migrate' and read the error it prints."
}

if ($Demo) {
    Info 'seeding the demo classroom'
    & $VenvPy manage.py seed_demo
}

if (-not (Select-String -Path .env -Pattern '^REDIS_URL=.+' -Quiet)) {
    Warn 'REDIS_URL is empty: the in-memory channel layer is used. Fine for a'
    Warn 'single-process local test; for a real class start Redis and set'
    Warn 'REDIS_URL=redis://127.0.0.1:6379/0 in .env.'
}

if ($SetupOnly) {
    Info "setup complete. Start the server with: $VenvPy manage.py runserver"
    exit 0
}

# ---------------------------------------------------------------- run
$env:ALLOWED_HOSTS = "localhost,127.0.0.1,[::1]"
$env:CSRF_TRUSTED_ORIGINS = "http://localhost:$Port,http://127.0.0.1:$Port"

Write-Host ''
Info "classroom is starting on http://localhost:$Port"
Info "first time? create a login:  $VenvPy manage.py createsuperuser"
Info 'then make a class at /classrooms/create/ and open its link in two windows.'
Info 'Ctrl+C stops the server.'
Write-Host ''

& $VenvPy manage.py runserver "0.0.0.0:$Port"
