# YANKENT POS — Safe Remote Update Guide

This is the release process for updating a client's installed YANKENT POS from your home laptop. The client does not need GitHub, developer tools, a password, or a visit from you. Your laptop prepares an immutable version tag; GitHub Actions builds and verifies the Windows installer; the installed app discovers the published release.

Important current state: GitHub's existing Latest release is missing `latest.yml`, so installed clients cannot complete an update check against it. The first successful release from the new workflow repairs the feed. Local release history already reaches `v2.2.5`; use the automatic version command below instead of copying an old version number.

## The short version

Commit only the source files you intend to ship. Then use this exact command; omitting `-Version` automatically selects the next unused patch version:

```powershell
cd C:\Users\Cyrhiel\POS-YANKENT; .\update.ps1 -Message "what you changed"
```

Use `-Message` only for plain release notes. Never paste a password or token there; the script checks the notes, tracked files, and every unpushed commit before it allows a release.

Preview the same release without creating a version commit, tag, push, build, or publication:

```powershell
cd C:\Users\Cyrhiel\POS-YANKENT; .\update.ps1 -Message "what you changed" -WhatIf
```

From any PowerShell folder, the equivalent command is:

```powershell
& 'C:\Users\Cyrhiel\POS-YANKENT\update.ps1' -Message 'what you changed'
```

To watch GitHub Actions and verify the published Latest release in the same terminal, add `-Wait`:

```powershell
.\update.ps1 -Message 'what you changed' -Wait
```

GitHub CLI is required for every release because the script uses its token to push the workflow, source commit, and tag. Sign in once with the required scopes:

```powershell
gh auth login -h github.com -w -s repo,workflow
gh auth setup-git --hostname github.com
```

If the account is already valid but lacks workflow permission, run `gh auth refresh -h github.com -s repo,workflow`. Without `-Wait`, open the Actions link printed by the script.

## What happens after the command

```text
Intentional clean commit on main
        |
        v
update.ps1: preflight -> lint/test -> version commit -> annotated tag -> atomic push
        |
        v
GitHub Actions: clean install -> lint/test/smoke -> Windows build -> artifact checks
        |
        v
Verified draft release -> optional release-environment approval -> published Latest release
        |
        v
Installed clients check quietly -> user chooses Download -> Restart & Install
```

The home laptop does not build or upload `dist` files. The tag-triggered workflow builds on a clean Windows runner and publishes these verified assets:

- `YANKENT-POS-Setup-X.Y.Z.exe`
- `YANKENT-POS-Setup-X.Y.Z.exe.blockmap`
- `latest.yml`
- `SHA256SUMS.txt`

Published tags and releases are immutable. The workflow may resume an unpublished draft after a transient failure, but it will not replace a release that clients may already have installed.

## One-time GitHub setup

Do this once before the first production release.

### 1. Confirm the workflow is on `main`

The repository must contain `.github/workflows/release.yml` on `main`, and GitHub Actions must be enabled.

In GitHub, open **Settings -> Actions -> General**. Ensure workflows are allowed and that `GITHUB_TOKEN` can write repository contents. The workflow itself keeps read-only permission for build steps and grants `contents: write` only to the draft/publish jobs.

Also create a GitHub tag ruleset for release tags matching `v*`. Allow authorized tag creation, but block tag updates and deletions and keep bypass access as narrow as possible. The workflow treats releases as immutable; the repository should enforce the same rule.

### 2. Create the protected release environment

Open **Settings -> Environments -> New environment** and create an environment named exactly:

```text
release
```

Recommended protection:

- Add yourself as a required reviewer, if the repository plan supports it.
- Limit deployment to release tags such as `v*`.
- Do not store the signing certificate only as an environment secret; the earlier Windows build job needs it before the `release` environment is entered.

With a required reviewer, GitHub builds and verifies a draft first, then waits for your approval before making it visible to clients. Without a reviewer rule, a successful verified build publishes automatically.

### 3. Configure Windows code signing

Use a trusted Windows code-signing certificate in PFX/P12 format. In **Settings -> Secrets and variables -> Actions**, create these **repository secrets**:

- `WIN_CSC_LINK` — the certificate as a base64 string or another electron-builder-supported certificate link.
- `WIN_CSC_KEY_PASSWORD` — the certificate password.

To copy a local PFX as base64 without creating another plaintext file:

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes('C:\secure\YANKENT-code-signing.pfx')
) | Set-Clipboard
```

Paste the clipboard value into `WIN_CSC_LINK`. Never commit the certificate or password, place them in release notes, or send them to a client.

Before enabling those secrets, set `build.win.publisherName` in `package.json` to the exact publisher identity on the certificate. For example:

```json
"win": {
  "publisherName": "Exact certificate publisher name",
  "target": ["nsis"]
}
```

The workflow requires that value to appear in the packaged `app-update.yml` and verifies both the installer and unpacked app executable signatures. This prevents a signed installer from disabling publisher verification during later updates.

The workflow verifies the installer's Authenticode signature when signing is configured. It currently permits an unsigned release with a prominent warning, but clients will see **Unknown publisher** and Windows may show stronger warnings. Configure signing before routine remote deployment.

### 4. Confirm release visibility

The current client uses the GitHub updater provider without a client token. Therefore:

- A **public** release repository works without any GitHub account or token on the client's laptop.
- A **private** repository is not directly usable by these clients without an authenticated update service.
- Never embed a GitHub personal access token in the Electron app; a client could extract and reuse it.

If the source must remain private, change the architecture before deployment: publish update artifacts to a separate public release repository or use an authenticated generic update service. The current `package.json`, workflow, and installed clients all point to `chmoralla-code/POS-YANKENT`, so they must be changed together.

### 5. Prepare developer access

Your home laptop needs Git, Node.js, npm, this repository, and GitHub CLI. GitHub CLI supplies the scoped token used for the atomic source-and-tag push.

Install GitHub CLI and sign in once:

```powershell
gh auth login -h github.com -w -s repo,workflow
gh auth setup-git --hostname github.com
gh auth status --active --hostname github.com
```

For an existing valid login that lacks workflow permission, run `gh auth refresh -h github.com -s repo,workflow`.

No GitHub CLI or developer credentials belong on a client's laptop.

## Repeatable release procedure

### 1. Make and manually test the change

Run the app and exercise the feature you changed. For printer changes, test the old printer, a newly connected printer, failure recovery, and a real receipt or test page.

```powershell
Set-Location 'C:\Users\Cyrhiel\POS-YANKENT'
npm start
```

The release script runs lint and unit tests locally. GitHub repeats them and also runs the full IPC smoke test on a clean runner.

### 2. Commit only intentional source changes

Inspect the worktree first. Do not use `git add -A` for a release: this project can contain database backups, test reports, temporary tools, and unrelated edits.

```powershell
git status --short
git diff

# Name the exact files intended for this release.
git add -- src/main/updater.js src/renderer/js/settings.js tests/printer.test.js

# Review exactly what the commit will contain.
git diff --cached
git commit -m 'Fix detection for newly connected printers'
git status --short
```

Replace those example paths with the files you actually changed. The final `git status --short` must print nothing. The release script refuses any tracked, untracked, staged, or unstaged leftovers and never stages source files for you.

You may push the source commit yourself, or leave it ahead of `origin/main`; the release script atomically pushes the clean source history, version commit, and tag. If remote `main` has newer commits, the script stops and asks you to pull and review them.

### 3. Choose a version

The safest routine command omits `-Version`:

```powershell
.\update.ps1 -Message 'Fix detection for newly connected printers' -WhatIf
```

It finds the highest package, tag, Git-history, and published-release version, then selects the next patch. Use an explicit bump only when appropriate:

```powershell
.\update.ps1 -Bump patch -Message 'Fix receipt alignment' -WhatIf
.\update.ps1 -Bump minor -Message 'Add printer recovery tools' -WhatIf
.\update.ps1 -Bump major -Message 'Breaking database migration' -WhatIf
```

Use `-Version X.Y.Z` only when you deliberately need an exact number. Exact and bump modes are mutually exclusive, every version must be higher than all known history, and published versions can never be reused.

### 4. Preview, then release

Always preview first:

```powershell
.\update.ps1 -Message 'Fix detection for newly connected printers' -WhatIf
```

The preview fetches current branch/tag metadata and runs local lint/tests. It does not modify version manifests or create a release commit, tag, push, build, or publication.

If the preview passes, remove only `-WhatIf`:

```powershell
.\update.ps1 -Message 'Fix detection for newly connected printers'
```

The script updates both `package.json` and `package-lock.json`, commits only those two files, creates an annotated tag containing your release message, and atomically pushes `main` plus that tag. That tag starts GitHub Actions.
### 5. Review GitHub Actions and approve publication

Open the Actions URL printed by the script. The workflow must complete these stages:

1. **Test and build** — validates tag/package agreement, installs locked dependencies, runs lint/unit/smoke tests, builds Windows, rejects packaged SQLite databases, checks updater metadata, checks signing, and calculates SHA-256 hashes.
2. **Create and verify draft** — uploads exactly the expected files to a draft release.
3. **Publish verified release** — enters the `release` environment, waits for approval if configured, promotes the draft, and verifies it is GitHub's Latest release.

With `-Wait`, the terminal follows this run. An approval gate can leave it waiting until you approve the `release` deployment on GitHub.

### 6. Verify and notify the client

Before notifying anyone, confirm:

- The Actions run is green.
- The release is not a draft or prerelease and is marked **Latest**.
- The release contains exactly the installer, blockmap, `latest.yml`, and `SHA256SUMS.txt`.
- The workflow summary says the signature is valid, or you deliberately accepted its unsigned warning.
- The release notes describe what the client will notice.

Suggested client message:

> Connect to the internet and open YANKENT POS. If the update notice appears, click **Download**, wait for it to finish, then click **Restart & Install**. You can also use **Check for updates** on the login screen or in Settings. Your sales data stays on the laptop.

## Client behavior

Only a packaged NSIS installation can self-update; `npm start` and an unpacked development build cannot.

For an installed client, the app:

- Quietly checks about 30 seconds after launch.
- Checks again every six hours while it remains open.
- Checks only stable releases; prereleases are disabled.
- Does not automatically download or install. The user must choose Download and then Restart & Install.
- Can also check immediately from the login screen or Settings.
- Needs internet only for checking and downloading. Normal POS sales remain offline-first.

The client should close or finish active sales before installing. The installer is per-user, so it normally does not require administrator rights.

## Database safety

The installed database is stored in Electron's per-user app-data folder as `yankent.sqlite`, separate from the application installation. Normal updates replace application files, not this database. The installer is configured to retain app data, and the release workflow refuses to publish any build containing a packaged `.sqlite` file.

Still use a backup before any high-risk release, especially one that changes schema, inventory, sales, authentication, or backup/import code:

1. On the client app, open **Settings -> Backup & Import**.
2. Click **Backup Data**.
3. Copy the resulting `.yankent` file somewhere off the client laptop.
4. Test schema changes against a copy of real-shaped data before release.

Never add a client database or `.yankent` backup to Git. Never depend on installing an older executable after a database migration; an older app may not understand the newer schema.

If either release guard reports a tracked runtime backup under `data/`, preserve the local file but remove it from Git's index, review the staged deletion, and commit that cleanup intentionally:

```powershell
git rm --cached --ignore-unmatch -- ':(glob)data/**/*.sqlite' ':(glob)data/**/*.yankent'
git status --short
git commit -m 'Stop tracking runtime POS backups'
```

`git rm --cached` leaves the local backup files on disk. Because the repository is public, removing them in a new commit does not erase older Git history. Treat any real customer/store data and any Telegram bot token inside those backups as exposed: rotate the bot token before release, then plan a separate reviewed history purge if the backups contain real data.

## Failure recovery

### The script stops before creating a version commit

Nothing was published. Read the specific error, fix the dirty tree, branch, version, Git access, lint, or test problem, then rerun `-WhatIf`.

Common commands:

```powershell
git status --short
git branch --show-current
git fetch --prune --tags origin
git log --oneline --decorate --max-count 10
```

Do not discard unfamiliar work. Commit intended files separately and investigate unrelated files before removing them.

### The atomic push fails

The version commit and annotated tag remain local; no partial remote push should occur. Fix network/Git credentials, then use the exact retry command printed by `update.ps1`, for example:

```powershell
gh auth setup-git --hostname github.com
git push --atomic origin HEAD:refs/heads/main refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
```

Do not rerun the whole release script for that same version, and do not delete or move the tag.

### GitHub Actions fails before publication

If the failure is transient—runner outage, dependency download, or asset upload—use **Re-run jobs** in GitHub. You may also open **Actions -> Release Windows -> Run workflow** and enter the exact existing tag, such as `vX.Y.Z`. Manual workflow dispatch is for retrying an existing immutable tag, not inventing a new release from uncommitted code.

If a draft already exists, the workflow safely refreshes that draft and verifies its assets. It will not overwrite a published release.

If the tagged code itself is wrong, fix it in a new commit and release a higher version. Do not move the old tag.

### The release waits at the publish job

This is expected when the `release` environment requires approval. Review the completed build/draft stages, approve the deployment in GitHub, and let the workflow finish.

### A bad version was already published

Never delete and recreate it, never replace its installer, and never force-move its tag. Some clients may already have downloaded or installed it.

Create a forward rollback:

```powershell
# Revert the bad code while preserving history.
git revert <bad-commit-sha>

# Preview and publish a NEW, HIGHER patch version.
.\update.ps1 -Message 'Revert the faulty release' -WhatIf
.\update.ps1 -Message 'Revert the faulty release'
```

Electron updates move forward; publishing an older version will not downgrade a client already on a newer one. A higher corrective version is also safer for databases that may already have migrated.

### A client cannot see or download the update

Check, in order:

- The client is running an installed packaged copy, not a development/unpacked copy.
- The client is online and can reach GitHub Releases in a browser.
- The Actions run finished and the release is published, stable, and Latest.
- The new version is higher than the client's current version.
- The repository is public for the current token-free client design.
- The release has the installer, blockmap, and `latest.yml` assets.

If the update service is temporarily unreachable, have the client retry later. As a controlled fallback, send the exact published release URL so they can download the same verified installer and run it over the existing per-user installation. Do not send an installer copied from an unverified local `dist` folder.

## Files involved

- `update.ps1` — guarded local preflight, manifest bump, immutable tag, and atomic push.
- `.github/workflows/release.yml` — clean Windows build, verification, draft, approval, and publication.
- `package.json` / `package-lock.json` — app version and build/update provider configuration.
- `src/main/updater.js` — automatic/manual checks, download, and install state.
- `src/main/ipc/integrations.js` — update IPC handlers.
- `src/main/preload.js` — safe renderer bridge.
- `src/renderer/js/app.js` — login-screen update experience.
- `src/renderer/js/settings.js` — Settings update and backup controls.

The rule to remember: **commit intentionally, preview first, publish one new immutable version, and recover by moving forward to a higher version.**
