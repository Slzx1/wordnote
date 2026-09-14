param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $Executable" }
}

if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    $bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    $runtime = if (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { 'python' }
    Invoke-Checked $runtime @('-m', 'venv', '.venv')
}

$pythonRuntime = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
try {
    $requirementsBytes = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'requirements.txt'))
    $requirementsHash = [System.BitConverter]::ToString($hashAlgorithm.ComputeHash($requirementsBytes)).Replace('-', '')
} finally { $hashAlgorithm.Dispose() }
$dependencyStamp = Join-Path $PSScriptRoot '.venv\requirements.sha256'
$installedHash = if (Test-Path -LiteralPath $dependencyStamp) { Get-Content -LiteralPath $dependencyStamp -Raw } else { '' }
if ($installedHash.Trim() -ne $requirementsHash) {
    Invoke-Checked $pythonRuntime @('-m', 'pip', 'install', '-r', 'requirements.txt')
    Set-Content -LiteralPath $dependencyStamp -Value $requirementsHash -Encoding ascii
}

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js 20.19+ is required. Install Node.js, then run start.cmd again.' }
if (-not (Test-Path -LiteralPath 'node_modules')) { Invoke-Checked 'npm.cmd' @('ci') }
$buildFile = Get-Item -LiteralPath 'dist\index.html' -ErrorAction SilentlyContinue
$newestSource = Get-ChildItem -LiteralPath 'src' -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $buildFile -or $newestSource.LastWriteTime -gt $buildFile.LastWriteTime -or (Get-Item 'package-lock.json').LastWriteTime -gt $buildFile.LastWriteTime) {
    Invoke-Checked 'npm.cmd' @('run', 'build')
}
if ($NoBrowser) { $env:WORDNOTE_NO_BROWSER = '1' }
Invoke-Checked $pythonRuntime @('-m', 'backend.launcher')
