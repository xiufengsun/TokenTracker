# ──────────────────────────────────────────────
# bundle-node.ps1  (Windows counterpart of TokenTrackerBar/scripts/bundle-node.sh)
#
# Downloads the pinned Node.js win-x64 binary and bundles the tokentracker CLI
# source + built dashboard into EmbeddedServer/, so the .exe is self-contained.
#
#   powershell -ExecutionPolicy Bypass -File scripts\bundle-node.ps1
#   ... -Clean       # wipe EmbeddedServer\ and exit
#
# Build the dashboard first, WITH the floating-pet entry (off by default so the
# macOS/web builds stay byte-identical):
#   $env:TOKENTRACKER_BUILD_PET = "1"; npm run dashboard:build   (from the repo root)
# ──────────────────────────────────────────────
param([switch]$Clean)

$ErrorActionPreference = 'Stop'

# Keep this pinned version in sync with TokenTrackerBar/scripts/bundle-node.sh.
$ExpectedNodeVersion = '22.22.2'
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { $ExpectedNodeVersion }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$WinProjDir = Split-Path -Parent $ScriptDir
$RepoRoot  = Split-Path -Parent $WinProjDir
$EmbedDir  = Join-Path $WinProjDir 'EmbeddedServer'

if ($Clean) {
    if (Test-Path $EmbedDir) { Remove-Item -Recurse -Force $EmbedDir }
    Write-Host 'Cleaned EmbeddedServer\'
    exit 0
}

if ($NodeVersion -ne $ExpectedNodeVersion) {
    Write-Error "Refusing to bundle Node v$NodeVersion; expected pinned v$ExpectedNodeVersion. Run npm test against the new Node first."
}

if (Test-Path $EmbedDir) { Remove-Item -Recurse -Force $EmbedDir }
New-Item -ItemType Directory -Force -Path $EmbedDir | Out-Null

# 1. Download Node.js win-x64
$zipName = "node-v$NodeVersion-win-x64.zip"
$url = "https://nodejs.org/dist/v$NodeVersion/$zipName"

# Use cache directory if available (CI caches pinned Node.js downloads)
$cacheDir = $env:NODE_CACHE_DIR
$tmp = if ($cacheDir -and (Test-Path $cacheDir)) { $cacheDir } else {
    $t = Join-Path ([System.IO.Path]::GetTempPath()) "ttnode-$NodeVersion"
    if (Test-Path $t) { Remove-Item -Recurse -Force $t }
    New-Item -ItemType Directory -Force -Path $t | Out-Null
    $t
}
$zipPath = Join-Path $tmp $zipName

# Invoke-WebRequest is dramatically slower and more failure-prone on large files
# while the progress bar is rendered (a well-known Windows PowerShell issue), which
# is what truncates the ~28MB Node archive and trips the checksum below.
$ProgressPreference = 'SilentlyContinue'
$sumsPath = Join-Path $tmp 'SHASUMS256.txt'

# Download + verify against Node.js's official SHASUMS256.txt, with retries: a
# transient/partial download yields a checksum mismatch, so re-fetch rather than
# failing the whole release on one flaky CI download.
# Skip download if cached zip already exists and passes checksum.
$maxAttempts = 4
$verified = $false

if (Test-Path $zipPath) {
    # Attempt to verify cached file first
    $sumsPath = Join-Path $tmp 'SHASUMS256.txt'
    try {
        if (-not (Test-Path $sumsPath)) {
            Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $sumsPath
        }
        $expectedHash = (Select-String -Path $sumsPath -Pattern ([regex]::Escape($zipName)) |
            Select-Object -First 1).Line.Split(' ')[0]
        $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
        if ($expectedHash -and ($actualHash -eq $expectedHash.ToUpper())) {
            Write-Host "Using cached Node.js v$NodeVersion (checksum verified)"
            $verified = $true
        } else {
            Write-Host "Cached file checksum mismatch, re-downloading..."
            Remove-Item -Force $zipPath
        }
    } catch {
        Write-Warning "Cache verification failed: $($_.Exception.Message)"
        if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
    }
}
for ($attempt = 1; $attempt -le $maxAttempts -and (-not $verified); $attempt++) {
    try {
        Write-Host "Downloading Node.js v$NodeVersion (win-x64)... (attempt $attempt/$maxAttempts)"
        Invoke-WebRequest -Uri $url -OutFile $zipPath
        $sumsPath = Join-Path $tmp 'SHASUMS256.txt'
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $sumsPath
        $expectedHash = (Select-String -Path $sumsPath -Pattern ([regex]::Escape($zipName)) |
            Select-Object -First 1).Line.Split(' ')[0]
        if (-not $expectedHash) { throw "No checksum found for $zipName in SHASUMS256.txt" }
        $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash
        if ($actualHash -ne $expectedHash.ToUpper()) {
            throw "Checksum mismatch for $zipName (expected $expectedHash, got $actualHash)"
        }
        Write-Host "Checksum verified (SHA-256)"
        $verified = $true
        break
    } catch {
        Write-Warning "Download attempt $attempt failed: $($_.Exception.Message)"
        if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
        if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds ($attempt * 3) }
    }
}
if (-not $verified) {
    Write-Error "Failed to obtain a valid Node.js v$NodeVersion archive after $maxAttempts attempts"
}

Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
$nodeExe = Join-Path $tmp "node-v$NodeVersion-win-x64\node.exe"
if (-not (Test-Path $nodeExe)) { Write-Error "node.exe not found in archive" }
Copy-Item $nodeExe (Join-Path $EmbedDir 'node.exe')

$bundledVersion = (& (Join-Path $EmbedDir 'node.exe') -p 'process.versions.node').Trim()
if ($bundledVersion -ne $ExpectedNodeVersion) {
    Write-Error "Bundled Node drifted: expected v$ExpectedNodeVersion, got v$bundledVersion"
}
Write-Host "Node.js ready - v$bundledVersion"

# 2. Bundle tokentracker source
$ttDir = Join-Path $EmbedDir 'tokentracker'
New-Item -ItemType Directory -Force -Path (Join-Path $ttDir 'bin') | Out-Null
Copy-Item (Join-Path $RepoRoot 'bin\tracker.js') (Join-Path $ttDir 'bin\')
Copy-Item (Join-Path $RepoRoot 'src') (Join-Path $ttDir 'src') -Recurse
Copy-Item (Join-Path $RepoRoot 'package.json') $ttDir
# The lockfile pins transitive versions; without it `npm install` resolves
# whatever is newest at build time (undici 8.11.0 shipped in 1.0.2 this way).
Copy-Item (Join-Path $RepoRoot 'package-lock.json') $ttDir

$dashDist = Join-Path $RepoRoot 'dashboard\dist'
if (Test-Path $dashDist) {
    New-Item -ItemType Directory -Force -Path (Join-Path $ttDir 'dashboard') | Out-Null
    Copy-Item $dashDist (Join-Path $ttDir 'dashboard\dist') -Recurse
} else {
    Write-Warning "dashboard\dist not found - run 'npm run dashboard:build' first. Continuing without dashboard assets."
}

# 3. Install production dependencies
Write-Host 'Installing production dependencies...'
Push-Location $ttDir
try {
    & npm ci --omit=dev --no-optional --ignore-scripts | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# 4. Trim node_modules bloat
$nm = Join-Path $ttDir 'node_modules'
if (Test-Path $nm) {
    Get-ChildItem $nm -Recurse -File -Include `
        '*.md','*.txt','*.map','*.ts','*.d.ts','LICENSE*','LICENCE*', `
        'CHANGELOG*','CHANGES*','HISTORY*','.npmignore','.eslintrc*', `
        '.prettierrc*','tsconfig.json','.editorconfig' `
        -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem $nm -Recurse -Directory -Include `
        'test','tests','__tests__','examples','example','docs','.github' `
        -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

$total = [math]::Round((Get-ChildItem $EmbedDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Bundle complete: $EmbedDir ($total MB)"
