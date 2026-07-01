# YANKENT POS — Remote Update Guide

How to push a new version of the app to the client's laptop WITHOUT traveling there.
The client clicks "Check for Updates" and the app downloads + installs the new version over the internet.

---

## How the update system works (1-minute overview)

YOU (dev laptop)
  1. Change code
  2. Bump version in package.json
  3. npm run dist  ->  installer + latest.yml + blockmap
  4. Publish GitHub Release v1.0.x
        |
        |  (electron-updater queries the GitHub Releases API)
        v
CLIENT (remote laptop)
  5. Opens app -> clicks "Check for Updates"
  6. Sees "v1.0.x available"
  7. Download -> Install -> App restarts automatically

KEY RULE: electron-updater compares the client's version against the latest NON-prerelease GitHub Release on chmoralla-code/POS-YANKENT. If the release version is higher, it offers the update.

The client must be online ONLY during the check + download. The POS itself is offline-first; daily sales never need internet.

---

## One-time prerequisites (already done on this machine)

- electron-updater dependency installed
- publish block in package.json pointing to chmoralla-code/POS-YANKENT
- src/main/updater.js wired to autoUpdater
- Login screen + Settings -> Updates UI calling the update IPC
- GitHub CLI (gh) authenticated with repo access
- First release v1.0.1 published with latest.yml + installer + blockmap

If any of these break, fix them once. Then the repeatable flow below is all you need.

---

## Repeatable update flow (do this EVERY time you ship a change)

### Step 1 — Make and test your code changes

  cd C:\Users\Cyrhiel\POS-YANKENT
  npm run lint
  npm test
  npm start

Do NOT skip "npm start". Unit tests do not cover the UI. Manually click through the feature you changed.

### Step 2 — Commit and push to main

  git add -A
  git commit -m "Describe the change here"
  git push origin main

### Step 3 — Bump the version

Edit package.json, change:

  "version": "1.0.1"

to:

  "version": "1.0.2"

Then commit the bump:

  git add package.json
  git commit -m "Bump version to 1.0.2"
  git push origin main

VERSIONING RULES:
  1.0.x  -> bug fixes, small tweaks
  1.x.0  -> new features
  x.0.0  -> breaking changes (rare for a POS)

The new version MUST be higher than what the client currently runs, or "Check for Updates" will say "up to date."

### Step 4 — Build the Windows installer

  npm run dist

This runs electron-builder --win and produces in dist/:

  YANKENT-POS-Setup-1.0.2.exe          <- the installer
  YANKENT-POS-Setup-1.0.2.exe.blockmap <- differential download map
  latest.yml                            <- version metadata electron-updater reads

ALL 3 FILES ARE REQUIRED. electron-updater will fail silently if latest.yml is missing from the release.

### Step 5 — Publish the GitHub Release

EASY WAY (one command, requires gh CLI):

  gh release create v1.0.2 --repo chmoralla-code/POS-YANKENT --title "1.0.2" --notes "What changed: - Fix ... - Add ..." dist/YANKENT-POS-Setup-1.0.2.exe dist/YANKENT-POS-Setup-1.0.2.exe.blockmap dist/latest.yml

MANUAL WAY (GitHub website):
  1. Go to https://github.com/chmoralla-code/POS-YANKENT/releases/new
  2. Choose tag -> Create new tag: v1.0.2
  3. Title: 1.0.2
  4. Description: list the changes
  5. Attach ALL 3 files from dist/
  6. Tick "Set as the latest release"
  7. Do NOT mark as a pre-release
  8. Publish release

### Step 6 — Tell the client

Send a message to the client (SMS, chat, call):

  "Open YANKENT POS. On the login screen, click 'Check for Updates'. It will say a new version is available. Click Download, then Install. The app will restart by itself. You need internet only for this step."

The client does NOT need admin rights on Windows because the installer was built with perMachine: false (user-level install).

---

## Verification checklist (before you walk away)

  [ ] git log shows your change + the version bump on origin/main
  [ ] dist/ contains the 3 files with the NEW version number in the name
  [ ] gh release view v1.0.2 lists 3 assets (exe, blockmap, latest.yml)
  [ ] The release is marked "Latest" (not draft, not prerelease)
  [ ] latest.yml inside the release shows the new version (open it and check)

---

## Troubleshooting

PROBLEM: Client clicks "Check for Updates" and it says "up to date" but you DID publish a new release.
  CAUSE 1: You forgot to bump package.json version. The release tag and the version inside latest.yml must be higher than the client's current version.
  CAUSE 2: The release is marked as a prerelease. electron-updater skips prereleases by default.
  CAUSE 3: latest.yml is missing from the release assets. Re-upload it.
  CAUSE 4: The client is offline. Have them connect to the internet, then check again.

PROBLEM: Client sees the update but the download fails or hangs.
  CAUSE: Slow/blocked internet. GitHub Releases is usually reachable. Have them retry. If on a restricted network, they can download the .exe directly from the release page on a browser and install it on top.

PROBLEM: "Dev mode — publish a GitHub Release to test updates" toast appears.
  CAUSE: The app was started with "npm start" (not packaged). electron-updater only runs in a packaged build. To test the update flow for real, run "npm run dist", install the produced setup.exe, and use THAT installed copy.

PROBLEM: You accidentally published a release with the wrong files.
  FIX:  gh release delete v1.0.2 --repo chmoralla-code/POS-YANKENT
        Then re-create it with the correct files.

PROBLEM: The client's installed version is NEWER than the release you just published.
  CAUSE: You published 1.0.3 earlier, then tried to re-publish 1.0.2. electron-updater only goes forward. Publish 1.0.4 instead.

---

## Quick reference — the 6 commands you actually run

  cd C:\Users\Cyrhiel\POS-YANKENT
  npm run lint; npm test; npm start
  git add -A; git commit -m "your change"; git push origin main
  # edit package.json version -> 1.0.2
  git add package.json; git commit -m "Bump version to 1.0.2"; git push origin main
  npm run dist
  gh release create v1.0.2 --repo chmoralla-code/POS-YANKENT --title "1.0.2" --notes "..." dist/YANKENT-POS-Setup-1.0.2.exe dist/YANKENT-POS-Setup-1.0.2.exe.blockmap dist/latest.yml

Then message the client: "Click Check for Updates in the app."

---

## One-command shortcut: update.ps1

Does lint + test + commit + push + version bump + build + GitHub release in one shot.

  cd C:\Users\Cyrhiel\POS-YANKENT
  .\update.ps1 -Message "what you changed"

Set an exact version (any X.Y.Z higher than the client's current one):

  .\update.ps1 -Message "what you changed" -Version "2.1.0"

Auto-bump instead (default is patch):

  .\update.ps1 -Message "what you changed" -Bump minor   # 2.0.5 -> 2.1.0
  .\update.ps1 -Message "what you changed" -Bump major   # 2.0.5 -> 3.0.0

Skip the build/release (commit + push + version bump only):

  .\update.ps1 -Message "what you changed" -SkipBuild

Notes:
  - -Version takes priority over -Bump.
  - The new version MUST be higher than what the client runs, or "Check for Updates" says "up to date".
  - If PowerShell blocks the script, run once:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  - Requires `gh` (GitHub CLI) to be authenticated with repo access.

---

## File map (where things live if something breaks)

  package.json                          -> version + publish target + build config
  src/main/updater.js                   -> electron-updater logic (autoDownloader)
  src/main/ipc/integrations.js          -> IPC handlers: pos:update:check/download/install
  src/main/preload.js                   -> window.pos.update.* bridge
  src/renderer/js/app.js                -> Login screen "Check for Updates" button
  src/renderer/js/settings.js           -> Settings -> Updates panel UI
  dist/                                 -> build output (installer + latest.yml + blockmap)
  GitHub repo releases page             -> where the client's app fetches updates from
