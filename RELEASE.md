# Release Process

> **The upstream release process below does not apply to this fork.** In this fork `zeenha` is the trunk, and releases go through `scripts/zeenha-release.sh`, which only a human runs:
>
> - `scripts/zeenha-release.sh`: test, build, push, install the next `zeenha.N`
> - `scripts/zeenha-release.sh --no-install`: same, but stop before replacing the installed app
> - `scripts/zeenha-release.sh --install <AppImage>`: install a build that already exists
> - `scripts/zeenha-release.sh --rollback`: swap back to the previous install
>
> `APERANT_INSTALL_DIR` overrides the install directory (default `~/Applications/aperant-zeenha`).

<!-- zeenha fork: rehearse manual installs without changing a real install or publishing a release. -->
## Fork only: Desktop artifact smoke checks

### Linux x64: install, upgrade, and roll back

Run this rehearsal by hand on a **fresh, non-root, disposable Linux x64 VM or account** with its own display session. Do not use your everyday account, mount your real home or profile, or forward credential agents. Use trusted local Git refs in a checkout that includes the smoke scripts. Environment overrides are not a security boundary. No provider sign-in, Ollama service, or model download is needed.

- Put Node.js **24**, npm, Git, Bash, and tar on `PATH`. Install native build tools (Python 3, `make`, a C/C++ compiler, and `pkg-config`) and Electron desktop libraries (GTK 3, NSS, ALSA, and X11 libraries). Use a working X11 display or install Xvfb and `xauth` for the examples below.
- Allow access to public dependency and build-tool downloads and leave room in `/tmp` for two independent builds. If the packaged app cannot run with the available display or sandbox policy, use a compatible disposable runner or report **not run**. Do not weaken the developer host’s sandbox or AppArmor policy.

From the checkout root, build both versions from the same committed source (the desktop version must end in `.zeenha.N`):

```bash
xvfb-run --auto-servernum node scripts/smoke-desktop-linux.mjs --run --baseline-ref HEAD
```

The runner exports `HEAD` twice, installs dependencies separately with `npm ci`, and bumps `zeenha.N` only in the generated candidate’s desktop manifest after dependency installation. This checks swapping, not migration compatibility.

To test two distinct revisions, replace `local-baseline` and `local-candidate` with trusted refs already present locally. The candidate must have a higher valid desktop version:

```bash
xvfb-run --auto-servernum node scripts/smoke-desktop-linux.mjs --run --baseline-ref local-baseline --candidate-ref local-candidate --keep-diagnostics
```

Both builds use `--publish never`. With its own temporary `APERANT_INSTALL_DIR`, the smoke runner invokes `scripts/zeenha-release.sh` only as `--install <A.AppImage>`, `--install <B.AppImage>`, and `--rollback`, in that order. It launches and closes the **installed, extracted `aperant` binary** after each step. Do not substitute the release script’s default mode or `--no-install`: **`--no-install` still pushes**.

A pass requires correct `.previous` bookkeeping and real packaged launches reporting versions **A → B → A** via IPC on Linux x64. All three launches must use one disposable profile and preserve the fixture Git repo’s HEAD and marker, project ID, canonical path, and branch setting. The packaged terminal must read the fixture marker, and the local libSQL query must return a zero project memory count with `memory.db` in that profile and still present at the next launch.

Stage records go to stdout and to `/tmp/aperant-smoke-*/logs/stages.jsonl` during the run. They include the source commits, expected versions, AppImage names and SHA-256 hashes, and observed launch results. Look for the JSON record `{"stage":"rehearsal","status":"passed"}` and exit code zero; a failure exits nonzero. The runner closes its own processes and removes the temporary builds, install, fixture, profile, and logs. `--keep-diagnostics` retains only a sanitized `/tmp/aperant-smoke-report-*/report.json`; the runner prints the exact path. If cleanup fails or process exit cannot be confirmed, retire the disposable runner rather than reusing its paths.

### Windows and macOS: advisory native launch checks

In the fork’s GitHub **Actions**, select **Desktop Artifact Smoke** → **Run workflow**. Choose a trusted ref that includes the workflow and smoke scripts, then select `all` or one target:

| Target | Built artifact | Native runner |
| --- | --- | --- |
| `windows-x64` | Windows x64 ZIP | `windows-latest` |
| `macos-arm64` | macOS arm64 DMG | `macos-15` |
| `macos-x64` | macOS x64 DMG | `macos-15-intel` |

Read the workflow run’s **Summary** for one row per target with artifact name (or `not-produced`), source and expected version, observed version and architecture when available, and stage or reason. **pass** means the packaged app launched and passed the fixture Git, terminal, and local database checks. **fail** means an attempted check failed. **not run** means the target was unselected, no compatible runner was available, or the run ended without completed evidence. The workflow uploads result records, not packages.

Running from an extracted ZIP is not an NSIS installation test. Launching the app copied from a DMG does not validate distribution signing, notarization, or Gatekeeper. These checks do not publish binaries, add a CI or release gate, or enable in-app updates. Even a successful Linux rollback applies only to the tested builds and disposable state; it is not a general rollback or migration guarantee.

## Upstream release process

This document describes how releases are created for Auto Claude.

## Overview

Auto Claude uses an automated release pipeline that ensures releases are only published after all builds succeed. This prevents version mismatches between documentation and actual releases.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RELEASE FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   develop branch                    main branch                              │
│   ──────────────                    ───────────                              │
│        │                                 │                                   │
│        │  1. bump-version.js             │                                   │
│        │     (creates commit)            │                                   │
│        │                                 │                                   │
│        ▼                                 │                                   │
│   ┌─────────┐                           │                                   │
│   │ v2.8.0  │  2. Create PR             │                                   │
│   │ commit  │ ────────────────────►     │                                   │
│   └─────────┘                           │                                   │
│                                          │                                   │
│                           3. Merge PR    ▼                                   │
│                                    ┌──────────┐                              │
│                                    │ v2.8.0   │                              │
│                                    │ on main  │                              │
│                                    └────┬─────┘                              │
│                                         │                                    │
│                     ┌───────────────────┴───────────────────┐               │
│                     │     GitHub Actions (automatic)         │               │
│                     ├───────────────────────────────────────┤               │
│                     │ 4. prepare-release.yml                 │               │
│                     │    - Detects version > latest tag      │               │
│                     │    - Creates tag v2.8.0                │               │
│                     │                                        │               │
│                     │ 5. release.yml (triggered by tag)      │               │
│                     │    - Builds macOS (Intel + ARM)        │               │
│                     │    - Builds Windows                    │               │
│                     │    - Builds Linux                      │               │
│                     │    - Generates changelog               │               │
│                     │    - Creates GitHub release            │               │
│                     │    - Updates README                    │               │
│                     └───────────────────────────────────────┘               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## For Maintainers: Creating a Release

### Step 1: Bump the Version

On your development branch (typically `develop` or a feature branch):

```bash
# Navigate to project root
cd /path/to/auto-claude

# Bump version (choose one)
node scripts/bump-version.js patch   # 2.7.1 -> 2.7.2 (bug fixes)
node scripts/bump-version.js minor   # 2.7.1 -> 2.8.0 (new features)
node scripts/bump-version.js major   # 2.7.1 -> 3.0.0 (breaking changes)
node scripts/bump-version.js 2.8.0   # Set specific version
```

This will:
- Update `apps/desktop/package.json`
- Update `package.json` (root)
- Check if `CHANGELOG.md` has an entry for the new version (warns if missing)
- Create a commit with message `chore: bump version to X.Y.Z`

### Step 2: Update CHANGELOG.md (REQUIRED)

**IMPORTANT: The release will fail if CHANGELOG.md doesn't have an entry for the new version.**

Add release notes to `CHANGELOG.md` at the top of the file:

```markdown
## 2.8.0 - Your Release Title

### ✨ New Features
- Feature description

### 🛠️ Improvements
- Improvement description

### 🐛 Bug Fixes
- Fix description

---
```

Then amend the version bump commit:

```bash
git add CHANGELOG.md
git commit --amend --no-edit
```

### Step 3: Push and Create PR

```bash
# Push your branch
git push origin your-branch

# Create PR to main (via GitHub UI or gh CLI)
gh pr create --base main --title "Release v2.8.0"
```

### Step 4: Merge to Main

Once the PR is approved and merged to `main`, GitHub Actions will automatically:

1. **Detect the version bump** (`prepare-release.yml`)
2. **Validate CHANGELOG.md** has an entry for the new version (FAILS if missing)
3. **Extract release notes** from CHANGELOG.md
4. **Create a git tag** (e.g., `v2.8.0`)
5. **Trigger the release workflow** (`release.yml`)
6. **Build binaries** for all platforms:
   - macOS Intel (x64) - code signed & notarized
   - macOS Apple Silicon (arm64) - code signed & notarized
   - Windows (NSIS installer) - code signed
   - Linux (AppImage + .deb)
7. **Scan binaries** with VirusTotal
8. **Create GitHub release** with release notes from CHANGELOG.md
9. **Update README** with new version badge and download links

### Step 5: Verify

After merging, check:
- [GitHub Actions](https://github.com/AndyMik90/Auto-Claude/actions) - ensure all workflows pass
- [Releases](https://github.com/AndyMik90/Auto-Claude/releases) - verify release was created
- [README](https://github.com/AndyMik90/Auto-Claude#download) - confirm version updated

## Version Numbering

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (X.0.0): Breaking changes, incompatible API changes
- **MINOR** (0.X.0): New features, backwards compatible
- **PATCH** (0.0.X): Bug fixes, backwards compatible

## Changelog Management

Release notes are managed in `CHANGELOG.md` and used for GitHub releases.

### Changelog Format

Each version entry in `CHANGELOG.md` should follow this format:

```markdown
## X.Y.Z - Release Title

### ✨ New Features
- Feature description with context

### 🛠️ Improvements
- Improvement description

### 🐛 Bug Fixes
- Fix description

---
```

### Changelog Validation

The release workflow **validates** that `CHANGELOG.md` has an entry for the version being released:

- If the entry is **missing**, the release is **blocked** with a clear error message
- If the entry **exists**, its content is used for the GitHub release notes

### Writing Good Release Notes

- **Be specific**: Instead of "Fixed bug", write "Fixed crash when opening large files"
- **Group by impact**: Features first, then improvements, then fixes
- **Credit contributors**: Mention contributors for significant changes
- **Link issues**: Reference GitHub issues where relevant (e.g., "Fixes #123")

## Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `prepare-release.yml` | Push to `main` | Detects version bump, **validates CHANGELOG.md**, creates tag |
| `release.yml` | Tag `v*` pushed | Builds binaries, extracts changelog, creates release |
| `update-readme` (in release.yml) | After release | Updates README with new version |

## Troubleshooting

### Release didn't trigger after merge

1. Check if version in `package.json` is greater than latest tag:
   ```bash
   git tag -l 'v*' --sort=-version:refname | head -1
   cat apps/desktop/package.json | grep version
   ```

2. Ensure the merge commit touched `package.json`:
   ```bash
   git diff HEAD~1 --name-only | grep package.json
   ```

### Release blocked: Missing changelog entry

If you see "CHANGELOG VALIDATION FAILED" in the workflow:

1. The `prepare-release.yml` workflow validated that `CHANGELOG.md` doesn't have an entry for the new version
2. **Fix**: Add an entry to `CHANGELOG.md` with the format `## X.Y.Z - Title`
3. Commit and push the changelog update
4. The workflow will automatically retry when the changes are pushed to `main`

```bash
# Add changelog entry, then:
git add CHANGELOG.md
git commit -m "docs: add changelog for vX.Y.Z"
git push origin main
```

### Build failed after tag was created

- The release won't be published if builds fail
- Fix the issue and create a new patch version
- Don't reuse failed version numbers

### README shows wrong version

- README is only updated after successful release
- If release failed, README keeps the previous version (this is intentional)
- Once you successfully release, README will update automatically

## Manual Release (Emergency Only)

In rare cases where you need to bypass the automated flow:

```bash
# Create tag manually (NOT RECOMMENDED)
git tag -a v2.8.0 -m "Release v2.8.0"
git push origin v2.8.0

# This will trigger release.yml directly
```

**Warning:** Only do this if you're certain the version in package.json matches the tag.

## Security

- All macOS binaries are code signed with Apple Developer certificate
- All macOS binaries are notarized by Apple
- Windows binaries are code signed
- All binaries are scanned with VirusTotal
- SHA256 checksums are generated for all artifacts
