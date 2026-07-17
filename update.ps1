# YANKENT POS - guarded remote release launcher
#
# GitHub Actions performs the clean Windows build, verifies every updater
# artifact, then publishes it. This script only prepares and pushes one
# immutable version commit + annotated tag.
#
# Examples:
#   .\update.ps1 -Message "Fix new-printer detection" -WhatIf
#   .\update.ps1 -Message "Fix new-printer detection"
#   .\update.ps1 -Message "Small receipt fix" -Wait
#
# One-time auth (needed to push .github/workflows):
#   gh auth login -h github.com -w -s repo,workflow
#   gh auth setup-git --hostname github.com
#
# Source changes must already be intentionally committed. This script never
# stages the working tree, deletes a release, or reuses a published version.
# Pushes use the GitHub CLI token so Windows OAuth-without-workflow cannot
# silently reject the release.

[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Bump', ConfirmImpact = 'Medium')]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Message,

  [Parameter(Mandatory = $true, ParameterSetName = 'Exact')]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version,

  [Parameter(ParameterSetName = 'Bump')]
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',

  [switch]$Wait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root
$releasePushed = $false
$telegramTokenPattern = '[0-9]{6,12}:[A-Za-z0-9_-]{30,50}'

function Step([int]$Number, [string]$Label) {
  Write-Host ''
  Write-Host "==> [$Number] $Label" -ForegroundColor Cyan
}

function Fail([string]$Text) { throw $Text }

function Run([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "$File failed with exit code $LASTEXITCODE." }
}

function Read-Tool([string]$File, [string[]]$Arguments) {
  $output = & $File @Arguments
  if ($LASTEXITCODE -ne 0) { Fail "$File failed with exit code $LASTEXITCODE." }
  return $output
}

function Read-NativeResult([string]$File, [string[]]$Arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  $nativeCommandPreference = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  $previousNativeCommandPreference = $null
  if ($null -ne $nativeCommandPreference) {
    $previousNativeCommandPreference = [bool]$nativeCommandPreference.Value
  }
  $output = @()
  $exitCode = -1
  try {
    # Windows PowerShell 5.1 converts redirected native stderr into
    # ErrorRecord objects. Capture it without letting normal gh status output
    # terminate the release before its real process exit code can be checked.
    $ErrorActionPreference = 'Continue'
    if ($null -ne $nativeCommandPreference) {
      $PSNativeCommandUseErrorActionPreference = $false
    }
    $output = @(& $File @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -ne $nativeCommandPreference) {
      $PSNativeCommandUseErrorActionPreference = $previousNativeCommandPreference
    }
  }

  return [pscustomobject]@{
    ExitCode = [int]$exitCode
    Output = @($output | ForEach-Object { [string]$_ })
  }
}

function Strict-Version([string]$Value, [string]$Label) {
  if ($Value -notmatch '^\d+\.\d+\.\d+$') {
    Fail "$Label must use X.Y.Z format (received '$Value')."
  }
  return [version]$Value
}

function Historical-Version([string]$Value, [string]$Label) {
  if ($Value -match '^v?(\d+)\.(\d+)\.(\d+)$') {
    return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
  }
  if ($Value -match '^v?(\d+)\.(\d+)$') {
    return [version]"$($Matches[1]).$($Matches[2]).0"
  }
  Fail "$Label '$Value' is not a stable numeric version. Refusing to guess the release order."
}

function Version-Text([version]$Value) {
  return "$($Value.Major).$($Value.Minor).$($Value.Build)"
}

function Read-NodeValue([string]$Expression, [string]$Label) {
  $value = (Read-Tool node @('-p', $Expression) | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) { Fail "$Label is empty." }
  return $value
}

function Get-HistoricalPackageVersions {
  $versions = @()
  $commits = @(
    Read-Tool git @('log', '--all', '--full-history', '--format=%H', '--', 'package.json') |
      Select-Object -Unique
  )

  foreach ($entry in $commits) {
    $commit = ([string]$entry).Trim()
    if (-not $commit) { continue }

    $json = (Read-Tool git @('show', "$($commit):package.json") | Out-String)
    try {
      $historicalPackage = $json | ConvertFrom-Json
    } catch {
      Fail "Could not parse package.json at commit $commit."
    }
    $versions += (Strict-Version ([string]$historicalPackage.version) "package.json at commit $commit")
  }

  return @($versions)
}

function Get-GitHubCliToken {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Fail @"
GitHub CLI (gh) is required to push releases.
Install: https://cli.github.com/
Then run once:
  gh auth login -h github.com -w -s repo,workflow
"@
  }

  $statusResult = Read-NativeResult gh @('auth', 'status', '--active', '--hostname', 'github.com')
  if ($statusResult.ExitCode -ne 0) {
    $statusDetail = ($statusResult.Output | Out-String).Trim()
    Fail @"
GitHub CLI login is missing or expired.
GitHub CLI response:
$statusDetail

Run this once in PowerShell, finish the browser login, then rerun update.ps1:
  gh auth login -h github.com -w -s repo,workflow
"@
  }

  $tokenResult = Read-NativeResult gh @('auth', 'token', '--hostname', 'github.com')
  $token = ($tokenResult.Output | Out-String).Trim()
  if ($tokenResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    Fail "Could not read a GitHub token from gh. Run: gh auth login -h github.com -w -s repo,workflow"
  }
  return $token
}

function Assert-GitHubWorkflowPushAuth {
  $token = Get-GitHubCliToken
  $headerResult = Read-NativeResult gh @('api', '-i', 'user')
  $headerOut = ($headerResult.Output | Out-String)
  if ($headerResult.ExitCode -ne 0) {
    $headerDetail = $headerOut.Trim()
    Fail @"
GitHub CLI token is invalid.
GitHub CLI response:
$headerDetail

Run:
  gh auth login -h github.com -w -s repo,workflow
"@
  }

  if ($headerOut -match '(?im)^x-oauth-scopes:\s*(.+)$') {
    $scopes = [string]$Matches[1]
    if ($scopes -notmatch '(?i)\bworkflow\b' -or $scopes -notmatch '(?i)\brepo\b') {
      Fail @"
Your GitHub token is missing the scopes needed to push .github/workflows.
Current scopes: $scopes
Run this once, approve the browser prompt, then rerun update.ps1:
  gh auth refresh -h github.com -s repo,workflow
"@
    }
  }

  return $true
}

function Push-ReleaseRefs([string]$Tag) {
  # Configure Git to ask gh for the scoped credential. This keeps the token
  # out of command-line arguments and still permits workflow-file pushes.
  $null = Assert-GitHubWorkflowPushAuth
  Run gh @('auth', 'setup-git', '--hostname', 'github.com')
  & git push --atomic origin `
    'HEAD:refs/heads/main' `
    "refs/tags/$($Tag):refs/tags/$Tag"
  if ($LASTEXITCODE -ne 0) {
    Fail @"
git push failed.
If the error mentions workflow scope, run:
  gh auth refresh -h github.com -s repo,workflow
Then retry:
  gh auth setup-git --hostname github.com
  git push --atomic origin HEAD:refs/heads/main refs/tags/$($Tag):refs/tags/$Tag
"@
  }
}

function Get-PublishedStableReleaseVersions([string]$Owner, [string]$Repository) {
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {}

  $headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'YANKENT-POS-release-script'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  $safeOwner = [Uri]::EscapeDataString($Owner)
  $safeRepo = [Uri]::EscapeDataString($Repository)
  $versions = @()
  $page = 1

  while ($true) {
    if ($page -gt 1000) { Fail 'GitHub release pagination exceeded its safety limit.' }
    $uri = "https://api.github.com/repos/$safeOwner/$safeRepo/releases?per_page=100&page=$page"
    try {
      $releaseResponse = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
      # Windows PowerShell 5.1 can preserve the REST response as one nested
      # Object[] here. Force pipeline enumeration so each release is checked.
      $releases = @($releaseResponse | ForEach-Object { $_ })
    } catch {
      Fail "Could not query all stable GitHub releases from the public REST API. Refusing to release without a monotonic version check. $($_.Exception.Message)"
    }

    foreach ($release in $releases) {
      if ($null -eq $release.draft -or $null -eq $release.prerelease -or $null -eq $release.tag_name) {
        Fail 'GitHub returned an unexpected release response. Refusing to release.'
      }
      if (-not [bool]$release.draft -and -not [bool]$release.prerelease) {
        $versions += (Historical-Version ([string]$release.tag_name) 'Published stable release tag')
      }
    }

    if ($releases.Count -lt 100) { break }
    $page++
  }

  return @($versions)
}

try {
  if ($Message -match $telegramTokenPattern) {
    Fail 'Release notes must not contain a Telegram bot token or any other password.'
  }
  Write-Host 'YANKENT POS remote release' -ForegroundColor Cyan
  Write-Host "Release notes: $Message"

  if ($PSCmdlet.ParameterSetName -eq 'Bump') {
    Write-Host "Version mode: automatic $Bump bump"
  } else {
    Write-Host "Version mode: exact $Version"
  }

  Step 1 'Local safety checks'
  foreach ($tool in @('git', 'node', 'npm', 'gh')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      Fail "Required tool '$tool' is not installed or is not on PATH."
    }
  }

  # Fail before lint/tests/version commits when GitHub cannot accept workflow pushes.
  $null = Assert-GitHubWorkflowPushAuth
  Write-Host 'GitHub CLI auth: ok (repo + workflow)' -ForegroundColor Green

  $insideRepo = (Read-Tool git @('rev-parse', '--is-inside-work-tree') | Out-String).Trim()
  if ($insideRepo -ne 'true') { Fail 'This folder is not a Git working tree.' }

  $branch = (Read-Tool git @('branch', '--show-current') | Out-String).Trim()
  if ($branch -ne 'main') { Fail "Releases must come from main; current branch is '$branch'." }

  $secretScanResult = Read-NativeResult git @('grep', '-a', '-l', '-E', $telegramTokenPattern, '--', '.')
  if ($secretScanResult.ExitCode -gt 1) {
    Fail "Could not scan tracked source files for embedded Telegram bot tokens (git grep exit $($secretScanResult.ExitCode))."
  }
  $secretFiles = @(
    $secretScanResult.Output |
      ForEach-Object { ([string]$_).Trim() } |
      Where-Object { $_ }
  )
  if ($secretFiles.Count -gt 0) {
    Write-Host 'Tracked files containing a Telegram bot token:' -ForegroundColor Red
    $secretFiles | ForEach-Object { Write-Host "  $_" }
    Fail 'A Telegram bot token is a password and must never be committed or packaged. Rotate the token, remove it from source/tests, and enter the replacement only in the installed app Settings.'
  }

  $localCommitResult = Read-NativeResult git @('rev-list', 'origin/main..HEAD')
  if ($localCommitResult.ExitCode -ne 0) {
    Fail 'Could not inspect commits that have not been pushed to origin/main.'
  }
  $localCommits = @(
    $localCommitResult.Output |
      ForEach-Object { ([string]$_).Trim() } |
      Where-Object { $_ }
  )
  $secretCommits = @()
  foreach ($commit in $localCommits) {
    $historyScanResult = Read-NativeResult git @('grep', '-a', '-l', '-E', $telegramTokenPattern, $commit, '--', '.')
    if ($historyScanResult.ExitCode -gt 1) {
      Fail "Could not scan unpushed commit $commit for embedded Telegram bot tokens (git grep exit $($historyScanResult.ExitCode))."
    }
    $treeContainsToken = $historyScanResult.ExitCode -eq 0
    $commitMessageResult = Read-NativeResult git @('show', '-s', '--format=%B', $commit)
    if ($commitMessageResult.ExitCode -ne 0) {
      Fail "Could not inspect the message for unpushed commit $commit."
    }
    $commitMessage = $commitMessageResult.Output -join "`n"
    if ($treeContainsToken -or $commitMessage -match $telegramTokenPattern) {
      $secretCommits += $commit
    }
  }
  if ($secretCommits.Count -gt 0) {
    Write-Host 'Unpushed commits containing a Telegram bot token:' -ForegroundColor Red
    $secretCommits |
      ForEach-Object { Write-Host "  $($_.Substring(0, [Math]::Min(12, $_.Length)))" }
    Fail 'Do not push these commits. Removing a token in a later commit does not remove it from Git history. Rotate the token, then rewrite or squash the local-only commits before releasing.'
  }

  $trackedDataFiles = @(Read-Tool git @('ls-files', '--', 'data'))
  $trackedPosData = @(
    $trackedDataFiles | Where-Object { [string]$_ -match '^data[\\/].*\.(?:sqlite|yankent)$' }
  )
  if ($trackedPosData.Count -gt 0) {
    Write-Host 'Tracked POS databases/backups:' -ForegroundColor Red
    $trackedPosData | ForEach-Object { Write-Host "  $_" }
    Fail 'Sensitive POS data is tracked under data/. Untrack it without deleting your local copies, update .gitignore, and assess/purge any sensitive public Git history before releasing. Review every backup first; this script will not delete or untrack data for you.'
  }
  $changes = @(Read-Tool git @('status', '--porcelain', '--untracked-files=all'))
  if ($changes.Count -gt 0) {
    Write-Host 'Uncommitted files:' -ForegroundColor Yellow
    $changes | Select-Object -First 50 | ForEach-Object { Write-Host "  $_" }
    if ($changes.Count -gt 50) { Write-Host "  ... and $($changes.Count - 50) more" }
    Fail 'Commit only the intended changes first. The release script will not stage files automatically.'
  }

  $packagePath = Join-Path $root 'package.json'
  $lockPath = Join-Path $root 'package-lock.json'
  try {
    $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
  } catch {
    Fail 'Could not parse package.json.'
  }

  $packageVersionText = Read-NodeValue "require('./package.json').version" 'package.json version'
  $lockVersionText = Read-NodeValue "require('./package-lock.json').packages[''].version" 'package-lock.json root version'
  $packageVersion = Strict-Version $packageVersionText 'package.json version'
  $lockVersion = Strict-Version $lockVersionText 'package-lock.json root version'
  if ($packageVersion -ne $lockVersion) {
    Fail "package.json ($(Version-Text $packageVersion)) and package-lock.json ($(Version-Text $lockVersion)) do not match."
  }

  $owner = [string]$package.build.publish.owner
  $repo = [string]$package.build.publish.repo
  if (-not $owner -or -not $repo) { Fail 'package.json is missing build.publish owner/repo.' }

  $originUrl = (Read-Tool git @('remote', 'get-url', 'origin') | Out-String).Trim()
  $expected = "github.com[/:]$([regex]::Escape($owner))/$([regex]::Escape($repo))(?:\.git)?$"
  if ($originUrl -notmatch $expected) { Fail "origin '$originUrl' is not $owner/$repo." }

  Step 2 'Synchronize metadata and establish the version floor'
  Run git @('fetch', '--prune', '--tags', 'origin')

  $counts = ((Read-Tool git @('rev-list', '--left-right', '--count', 'origin/main...HEAD') | Out-String).Trim() -split '\s+')
  if ($counts.Count -ne 2) { Fail 'Could not compare local main with origin/main.' }
  $behind = [int]$counts[0]
  $ahead = [int]$counts[1]
  if ($behind -gt 0) {
    Fail "Local main is $behind commit(s) behind origin/main. Pull and review before releasing."
  }
  Write-Host "main: $ahead local commit(s) ready to push" -ForegroundColor Green

  $knownTags = @(Read-Tool git @('tag', '--list'))
  $tagVersions = @()
  foreach ($tagEntry in $knownTags) {
    $tagName = ([string]$tagEntry).Trim()
    if ($tagName -match '^v?\d+\.\d+(?:\.\d+)?$') {
      $tagVersions += (Historical-Version $tagName 'Stable Git tag')
    }
  }

  $historyVersions = @(Get-HistoricalPackageVersions)
  $publishedVersions = @(Get-PublishedStableReleaseVersions $owner $repo)
  $knownVersions = @($packageVersion) + $tagVersions + $historyVersions + $publishedVersions
  $baseline = $knownVersions | Sort-Object -Descending | Select-Object -First 1
  if ($null -eq $baseline) { Fail 'Could not calculate a historical version baseline.' }

  Write-Host "Version evidence: package=1, stable tags=$($tagVersions.Count), package history=$($historyVersions.Count), published stable releases=$($publishedVersions.Count)"
  Write-Host "Historical maximum: $(Version-Text $baseline)" -ForegroundColor Green

  if ($PSCmdlet.ParameterSetName -eq 'Exact') {
    $target = Strict-Version $Version '-Version'
  } else {
    switch ($Bump) {
      'major' { $target = [version]"$($baseline.Major + 1).0.0" }
      'minor' { $target = [version]"$($baseline.Major).$($baseline.Minor + 1).0" }
      default { $target = [version]"$($baseline.Major).$($baseline.Minor).$($baseline.Build + 1)" }
    }
  }

  if ($target -le $baseline) {
    Fail "Version $(Version-Text $target) must be higher than the historical maximum $(Version-Text $baseline)."
  }

  $newVersion = Version-Text $target
  $tag = "v$newVersion"
  if ($knownTags -contains $tag) {
    Fail "$tag already exists. Releases are immutable; choose a higher version."
  }

  Write-Host "Package version: $(Version-Text $packageVersion)"
  Write-Host "Proposed release: $tag" -ForegroundColor Green

  Step 3 'Pre-release tests'
  Run npm @('run', 'lint')
  Run npm @('test')

  Step 4 'Prepare immutable release tag'
  if (-not $PSCmdlet.ShouldProcess("$owner/$repo", "create and push $tag")) {
    Write-Host ''
    Write-Host 'DRY RUN complete. No version files, release commit, tag, push, build, or publication occurred.' -ForegroundColor Green
    Write-Host 'Run the same command without -WhatIf when ready.'
    exit 0
  }

  Run npm @('version', $newVersion, '--no-git-tag-version', '--allow-same-version=false')
  $updatedPackageVersion = Read-NodeValue "require('./package.json').version" 'updated package.json version'
  $updatedLockVersion = Read-NodeValue "require('./package-lock.json').packages[''].version" 'updated package-lock.json root version'
  if ($updatedPackageVersion -ne $newVersion -or $updatedLockVersion -ne $newVersion) {
    Fail "npm version did not update both package manifests to $newVersion."
  }

  Run git @('add', '--', 'package.json', 'package-lock.json')
  $staged = @(Read-Tool git @('diff', '--cached', '--name-only'))
  $unexpected = @($staged | Where-Object { $_ -notin @('package.json', 'package-lock.json') })
  if ($unexpected.Count -gt 0) { Fail "Unexpected staged files: $($unexpected -join ', ')." }

  Run git @('commit', '-m', "chore(release): $tag")
  Run git @('tag', '-a', $tag, '-m', $Message)
  $tagCommit = (Read-Tool git @('rev-list', '-n', '1', $tag) | Out-String).Trim()
  if (-not $tagCommit) { Fail "Could not resolve $tag to a commit." }

  Step 5 'Push main and tag atomically'
  $releasePushStartedAt = [DateTime]::UtcNow
  try {
    Push-ReleaseRefs $tag
    $releasePushed = $true
  } catch {
    Write-Host 'The prepared commit/tag remain local. After fixing Git access, retry:' -ForegroundColor Yellow
    Write-Host "  gh auth login -h github.com -w -s repo,workflow"
    Write-Host "  gh auth setup-git --hostname github.com"
    Write-Host "  git push --atomic origin HEAD:refs/heads/main refs/tags/$($tag):refs/tags/$tag"
    throw
  }

  $actionsUrl = "https://github.com/$owner/$repo/actions/workflows/release.yml"
  $releaseUrl = "https://github.com/$owner/$repo/releases/tag/$tag"
  Write-Host ''
  Write-Host 'Release request pushed.' -ForegroundColor Green
  Write-Host "Actions: $actionsUrl"
  Write-Host "Release after verification: $releaseUrl"

  $releaseVerified = $false
  if ($Wait) {
    Step 6 'Find and watch the matching GitHub Actions run'
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
      Fail "The tag was pushed, but -Wait requires GitHub CLI. Install gh or open $actionsUrl."
    }
    $waitAuthResult = Read-NativeResult gh @('auth', 'status', '--active', '--hostname', 'github.com')
    if ($waitAuthResult.ExitCode -ne 0) {
      Fail "The tag was pushed, but GitHub CLI login is missing or expired. Run 'gh auth login -h github.com -w', then inspect $actionsUrl."
    }

    $discoveryTimeoutSeconds = 300
    $deadline = [DateTime]::UtcNow.AddSeconds($discoveryTimeoutSeconds)
    $runId = $null
    $runUrl = $null
    $lastLookupError = $null
    Write-Host "Waiting up to $discoveryTimeoutSeconds seconds for the workflow run tied to $tagCommit..."

    while (-not $runId -and [DateTime]::UtcNow -lt $deadline) {
      $runResult = Read-NativeResult gh @(
        'run', 'list',
        '--repo', "$owner/$repo",
        '--workflow', 'release.yml',
        '--limit', '100',
        '--json', 'databaseId,event,displayTitle,headSha,status,conclusion,createdAt,url'
      )
      $runExit = $runResult.ExitCode
      $runJson = ($runResult.Output | Out-String).Trim()

      if ($runExit -eq 0) {
        try {
          if ([string]::IsNullOrWhiteSpace($runJson)) {
            $runs = @()
          } else {
            $runResponse = $runJson | ConvertFrom-Json
            $runs = @($runResponse | ForEach-Object { $_ })
          }
          $matchingRuns = @(
            $runs |
              Where-Object {
                $runCreatedAt = [DateTimeOffset]::Parse([string]$_.createdAt).UtcDateTime
                $event = [string]$_.event
                $sameRelease = [string]$_.displayTitle -eq "Release $tag"
                $freshRun = $runCreatedAt -ge $releasePushStartedAt.AddSeconds(-10)
                $validEvent = ($event -eq 'push' -and [string]$_.headSha -eq $tagCommit) -or
                  $event -eq 'workflow_dispatch'
                $sameRelease -and $freshRun -and $validEvent
              } |
              Sort-Object -Property createdAt -Descending
          )
          if ($matchingRuns.Count -gt 0) {
            $runId = [string]$matchingRuns[0].databaseId
            $runUrl = [string]$matchingRuns[0].url
          }
        } catch {
          $lastLookupError = "Could not parse gh run list output: $($_.Exception.Message)"
        }
      } else {
        $lastLookupError = "gh run list failed: $runJson"
      }

      if (-not $runId) { Start-Sleep -Seconds 5 }
    }

    if (-not $runId) {
      $detail = if ($lastLookupError) { " Last error: $lastLookupError" } else { '' }
      Fail "Timed out after $discoveryTimeoutSeconds seconds waiting for the release workflow tied to $tagCommit.$detail Open $actionsUrl."
    }

    Write-Host "Workflow run: $runUrl" -ForegroundColor Green
    Run gh @('run', 'watch', $runId, '--repo', "$owner/$repo", '--interval', '10', '--exit-status')

    Step 7 'Verify the published GitHub release'
    $releaseJson = (Read-Tool gh @(
      'release', 'view', $tag,
      '--repo', "$owner/$repo",
      '--json', 'isDraft,isPrerelease,publishedAt,tagName,url'
    ) | Out-String).Trim()
    try {
      $release = $releaseJson | ConvertFrom-Json
    } catch {
      Fail "Workflow passed, but the release response could not be parsed for $tag."
    }

    if ([string]$release.tagName -ne $tag) {
      Fail "Workflow passed, but GitHub returned release '$($release.tagName)' instead of $tag."
    }
    if ([bool]$release.isDraft) {
      Fail "Workflow passed, but $tag is still a draft."
    }
    if ([bool]$release.isPrerelease) {
      Fail "Workflow passed, but $tag is marked as a prerelease."
    }
    if ([string]::IsNullOrWhiteSpace([string]$release.publishedAt)) {
      Fail "Workflow passed, but $tag has no publication timestamp."
    }

    $latestTag = (Read-Tool gh @('api', "repos/$owner/$repo/releases/latest", '--jq', '.tag_name') | Out-String).Trim()
    if ($latestTag -ne $tag) {
      Fail "Workflow passed, but GitHub Latest is '$latestTag' instead of '$tag'."
    }

    $releaseUrl = [string]$release.url
    $releaseVerified = $true
    Write-Host "Verified published stable Latest release: $releaseUrl" -ForegroundColor Green
  }

  if ($releaseVerified) {
    Write-Host ''
    Write-Host 'Client instruction:' -ForegroundColor Cyan
    Write-Host "Open YANKENT POS, click 'Check for updates', then Download and Restart & Install."
  } else {
    Write-Host ''
    Write-Host 'Do not notify the client yet.' -ForegroundColor Yellow
    Write-Host 'First confirm the Actions run is green and the release is published as stable GitHub Latest.'
    Write-Host 'Use -Wait next time for terminal verification before client instructions are shown.'
  }
} catch {
  Write-Host ''
  if ($releasePushed) {
    Write-Host "RELEASE TAG PUSHED; FOLLOW-UP STOPPED: $($_.Exception.Message)" -ForegroundColor Red
  } else {
    Write-Host "RELEASE STOPPED: $($_.Exception.Message)" -ForegroundColor Red
  }
  exit 1
}
