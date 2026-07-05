# YANKENT POS - one-command remote update
# Usage:
#   .\update.ps1 -Message "describe what changed"                       # auto bump patch
#   .\update.ps1 -Message "describe what changed" -Bump minor           # 2.0.5 -> 2.1.0
#   .\update.ps1 -Message "describe what changed" -Version "2.1.0"      # set exact version
# -Version takes priority over -Bump. Use -SkipBuild to commit/push/bump only.
# This script does lint, test, commit, version bump, build, publish release, and print the client message.
# The ONLY thing left for you is to forward the printed message to the client.

param(
  [Parameter(Mandatory = $true)]
  [string]$Message,
  [ValidateSet("patch", "minor", "major")]
  [string]$Bump = "patch",
  [string]$Version = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repo = "chmoralla-code/POS-YANKENT"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Fail($msg) { Write-Host "`nX  $msg" -ForegroundColor Red; exit 1 }
function Step($n, $label) { Write-Host "`n==> [$n] $label" -ForegroundColor Cyan }

Write-Host "YANKENT POS auto-update" -ForegroundColor Cyan
Write-Host "Message: $Message"
if ($Version) { Write-Host "Version: $Version (explicit)" } else { Write-Host "Bump:    $Bump" }

# ---- [1] Lint + test --------------------------------------------------
Step 1 "Lint + unit tests"
npm run lint
if ($LASTEXITCODE -ne 0) { Fail "Lint failed. Fix the errors above, then re-run." }
npm test
if ($LASTEXITCODE -ne 0) { Fail "Tests failed. Fix the failing tests above, then re-run." }

# ---- [2] Commit + push code changes -----------------------------------
Step 2 "Commit + push code"
git add -A
$pending = @(git status --porcelain)
if ($pending.Count -gt 0) {
  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { Fail "git commit failed." }
  git push origin main
  if ($LASTEXITCODE -ne 0) { Fail "git push failed." }
  Write-Host "Code committed + pushed." -ForegroundColor Green
} else {
  Write-Host "(nothing to commit - continuing)" -ForegroundColor Yellow
}

# ---- [3] Bump version -------------------------------------------------
Step 3 "Bump version"
$pkgPath = Join-Path $root "package.json"
$pkg = Get-Content $pkgPath -Raw
if ($pkg -notmatch '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"') { Fail "Could not parse version from package.json" }
$ma = [int]$Matches[1]; $mi = [int]$Matches[2]; $pa = [int]$Matches[3]
if ($Version) {
  if ($Version -notmatch '^\d+\.\d+\.\d+$') { Fail "-Version must look like 2.1.0 (got: $Version)" }
  $newVersion = $Version
} else {
  switch ($Bump) {
    "major" { $ma++; $mi = 0; $pa = 0 }
    "minor" { $mi++; $pa = 0 }
    "patch" { $pa++ }
  }
  $newVersion = "$ma.$mi.$pa"
}
# Guard: must be higher than current, or electron-updater will say "up to date".
$cmp = "$ma.$mi.$pa"
if ($newVersion -le $cmp) {
  Write-Host "Warning: new version $newVersion is not higher than current $cmp. The client will see 'up to date'." -ForegroundColor Yellow
}
$pkg = $pkg -replace '"version"\s*:\s*"\d+\.\d+\.\d+"', "`"version`": `"$newVersion`""
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($pkgPath, $pkg, $utf8NoBom)
git add package.json
git commit -m "Bump version to $newVersion"
if ($LASTEXITCODE -ne 0) { Fail "git commit of version bump failed." }
git push origin main
if ($LASTEXITCODE -ne 0) { Fail "git push of version bump failed." }
Write-Host "Version: $newVersion" -ForegroundColor Green

if ($SkipBuild) {
  Write-Host "`n=== -SkipBuild: code + version pushed. Build/release skipped. ===" -ForegroundColor Green
  exit 0
}

# ---- [4] Build installer ----------------------------------------------
Step 4 "Build Windows installer (this takes ~3 minutes)"
npm run dist
if ($LASTEXITCODE -ne 0) { Fail "Build failed." }

$exe      = "dist/YANKENT-POS-Setup-$newVersion.exe"
$blockmap = "dist/YANKENT-POS-Setup-$newVersion.exe.blockmap"
$yml      = "dist/latest.yml"
foreach ($f in @($exe, $blockmap, $yml)) {
  if (-not (Test-Path (Join-Path $root $f))) { Fail "Missing build file: $f" }
}
Write-Host "Build OK. 3 files present." -ForegroundColor Green

# ---- [5] Publish GitHub Release ---------------------------------------
Step 5 "Publish release v$newVersion"

# Delete an existing release with the same tag (if any) so re-publishing
# the same version works. The old release + its tag are removed with
# --cleanup-tag so the new release can be created fresh.
$existing = gh release view "v$newVersion" --repo $repo 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Existing release v$newVersion found - deleting + re-creating." -ForegroundColor Yellow
  gh release delete "v$newVersion" --repo $repo --yes --cleanup-tag
  if ($LASTEXITCODE -ne 0) { Fail "Could not delete existing release v$newVersion." }
}

# Create the release as a draft first (fast - no asset upload yet).
gh release create "v$newVersion" --repo $repo --title $newVersion --notes $Message --draft
if ($LASTEXITCODE -ne 0) { Fail "gh release create failed." }

# Upload assets separately with --clobber so retrying the same command
# replaces existing assets rather than failing. This is also more reliable
# for the ~100MB installer (no inline upload that can time out).
gh release upload "v$newVersion" --repo $repo $exe $blockmap $yml --clobber
if ($LASTEXITCODE -ne 0) { Fail "gh release upload failed." }

# Publish the release (switch from draft to live).
gh release edit "v$newVersion" --repo $repo --draft=false
if ($LASTEXITCODE -ne 0) { Fail "Could not publish release v$newVersion." }

# ---- [6] Verify -------------------------------------------------------
Step 6 "Verify release"
gh release view "v$newVersion" --repo $repo
if ($LASTEXITCODE -ne 0) { Fail "Could not verify release." }

Write-Host ""
Write-Host "=== DONE. Send this to the client (SMS / chat / call): ===" -ForegroundColor Green
Write-Host ""
Write-Host "Open YANKENT POS. On the login screen, click 'Check for Updates'." -ForegroundColor White
Write-Host "It will say a new version is available. Click Download, then Install." -ForegroundColor White
Write-Host "The app will restart by itself. You need internet only for this step." -ForegroundColor White
Write-Host ""
Write-Host "Release: https://github.com/$repo/releases/tag/v$newVersion" -ForegroundColor DarkGray
