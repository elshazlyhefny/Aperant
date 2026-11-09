# Contributing to Auto Claude

Thank you for your interest in contributing to Auto Claude! This document provides guidelines and instructions for contributing to the project.

## This Fork

This repository is `elshazlyhefny/Aperant`, a fork that Aperant itself develops. Upstream (`AndyMik90/Aperant`) has paused for a 3.0 rebuild, so `zeenha` is the trunk.

- **Base branch is `zeenha`.** Never target upstream's frozen `develop` branch and never open anything against `AndyMik90/Aperant`.
- **Set the default repo.** In a fresh clone run `gh repo set-default elshazlyhefny/Aperant`, because `gh` can otherwise pick the `upstream` remote.
- **CI must pass and a human merges.** Land work through pull requests into `zeenha`.
- **Mark fork-specific code** with a `zeenha fork:` comment that says why it exists.

> ⚠️ **Important:** Every PR targets `zeenha`.

## How to Contribute

| What you want to do | Where to start |
|----------------------|----------------|
| Bug fixes & small improvements | Open a PR directly |
| New features / architecture changes | Start a [GitHub Issue](https://github.com/elshazlyhefny/Aperant/issues) or ask in [Discord](https://discord.com/channels/1448614759996854284/1451298184612548779) first |
| Questions & setup help | [Discord #setup-help](https://discord.com/channels/1448614759996854284/1451298184612548779) |

## AI-Assisted Contributions

PRs built with AI tools (Claude, Codex, Copilot, etc.) are welcome here -- given what this project does, it would be odd if they weren't.

That said, we've seen AI-generated PRs that introduce regressions because the contributor didn't verify what the code actually does. To keep quality high, we ask that AI-assisted PRs include the following:

- **Flag it** -- mention AI assistance in the PR description (the PR template has a section for this)
- **State your testing level** -- untested, lightly tested, or fully tested
- **Share context if you can** -- prompts or session logs help reviewers understand intent
- **Confirm you understand the code** -- you should be able to describe what the PR does and how the underlying code works

AI-assisted PRs go through the same review process as any other contribution. Transparency just helps reviewers know where to look more carefully.

## Table of Contents

- [This Fork](#this-fork)
- [How to Contribute](#how-to-contribute)
- [AI-Assisted Contributions](#ai-assisted-contributions)
- [Contributor License Agreement (CLA)](#contributor-license-agreement-cla)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Development Setup](#development-setup)
- [Pre-commit Hooks](#pre-commit-hooks)
- [Code Style](#code-style)
- [Testing](#testing)
- [Continuous Integration](#continuous-integration)
- [Git Workflow](#git-workflow)
  - [Working with Forks](#working-with-forks)
  - [Branch Overview](#branch-overview)
  - [Main Branches](#main-branches)
  - [Supporting Branches](#supporting-branches)
  - [Branch Naming](#branch-naming)
  - [Where to Branch From](#where-to-branch-from)
  - [Pull Request Targets](#pull-request-targets)
  - [Releases](#releases-maintainers)
  - [Commit Messages](#commit-messages)
  - [PR Hygiene](#pr-hygiene)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)
- [Architecture Overview](#architecture-overview)

## Contributor License Agreement (CLA)

All contributors must sign our Contributor License Agreement (CLA) before contributions can be accepted.

### Why We Require a CLA

Auto Claude is currently licensed under AGPL-3.0. The CLA ensures the project has proper licensing flexibility should we introduce additional licensing options (such as commercial/enterprise licenses) in the future.

You retain full copyright ownership of your contributions.

### How to Sign

1. Open a Pull Request
2. The CLA bot will automatically comment with instructions
3. Comment on the PR with: `I have read the CLA Document and I hereby sign the CLA`
4. Done - you only need to sign once, and it applies to all future contributions

Read the full CLA here: [CLA.md](CLA.md)

## Prerequisites

Before contributing, ensure you have the following installed:

- **Node.js 24+** - For the Electron desktop app
- **npm 10+** - Package manager (comes with Node.js)
- **CMake** - Required for building native dependencies (e.g., node-pty)
- **Git** - Version control

### Installing Node.js 24+

**Windows:**
```bash
winget install OpenJS.NodeJS.LTS
```

**macOS:**
```bash
brew install node@24
```

**Linux (Ubuntu/Debian):**
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

**Linux (Fedora):**
```bash
sudo dnf install nodejs npm
```

### Installing CMake

**Windows:**
```bash
winget install Kitware.CMake
```

**macOS:**
```bash
brew install cmake
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt install cmake
```

**Linux (Fedora):**
```bash
sudo dnf install cmake
```

## Quick Start

The fastest way to get started:

```bash
# Clone the repository
git clone https://github.com/elshazlyhefny/Aperant.git
cd Aperant

# Install all dependencies (cross-platform)
npm run install:all

# Run in development mode
npm run dev

# Or build and run production
npm start
```

## Development Setup

The project is a single Electron desktop application in `apps/desktop/`. All AI agent logic lives in TypeScript using the Vercel AI SDK v6.

From the repository root:

```bash
# Install all dependencies
npm run install:all

# Start development mode (hot reload)
npm run dev
```

`npm run install:all` installs the npm dependencies for `apps/desktop/`.

### Other Useful Commands

```bash
npm start              # Build and run production
npm run build          # Build for production
npm run package        # Package for distribution
npm test               # Run frontend tests
```

<details>
<summary><b>Windows users:</b> If installation fails with node-gyp errors, click here</summary>

Auto Claude automatically downloads prebuilt binaries for Windows. If prebuilts aren't available for your Electron version yet, you'll need Visual Studio Build Tools:

1. Download [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. Select "Desktop development with C++" workload
3. In "Individual Components", add "MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs"
4. Restart terminal and run `npm install` again

</details>

> **Note:** For regular usage, we recommend downloading the pre-built releases from [GitHub Releases](https://github.com/elshazlyhefny/Aperant/releases). Running from source is primarily for contributors and those testing unreleased features.

## Pre-commit Hooks

We use Husky + lint-staged to run Biome linting and formatting checks before each commit.

### Setup

Husky is installed automatically when you run `npm install` inside `apps/desktop/`.

### What Runs on Commit

When you commit, the following checks run automatically on staged files:

| Check | Scope | Description |
|-------|-------|-------------|
| **Biome** | `apps/desktop/` | TypeScript/React linter + formatter |
| **typecheck** | `apps/desktop/` | TypeScript type checking |
| **trailing-whitespace** | All files | Removes trailing whitespace |
| **end-of-file-fixer** | All files | Ensures files end with newline |
| **check-yaml** | All files | Validates YAML syntax |
| **check-added-large-files** | All files | Prevents large file commits |

### Running Manually

```bash
cd apps/desktop

# Run linter (Biome)
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Run type checking
npm run typecheck
```

### If a Check Fails

1. **Biome auto-fixes**: Run `npm run lint:fix` in `apps/desktop/`. Stage the changes and commit again.
2. **Type errors**: Resolve TypeScript type issues before committing.

## Code Style

### TypeScript/React

- Use TypeScript strict mode
- Follow the existing component patterns in `apps/desktop/src/`
- Use functional components with hooks
- Prefer named exports over default exports
- Use the UI components from `src/renderer/components/ui/`

```typescript
// Good
export function TaskCard({ task, onEdit }: TaskCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  ...
}

// Avoid
export default function(props) {
  ...
}
```

### General

- No trailing whitespace
- Use 2 spaces for indentation in TypeScript/JSON, 4 spaces in Python
- End files with a newline
- Keep line length under 100 characters when practical

## Testing

### Frontend Tests

```bash
cd apps/desktop

# Run unit tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage

# Run E2E tests (requires built app)
npm run build
npm run test:e2e

# Run linting
npm run lint

# Run type checking
npm run typecheck
```

### Testing Requirements

Before submitting a PR:

1. **All existing tests must pass**
2. **New features should include tests**
3. **Bug fixes should include a regression test**
4. **Test coverage should not decrease significantly**

## Continuous Integration

All pull requests and pushes to `main` trigger automated CI checks via GitHub Actions.

### Workflows

| Workflow | Trigger | What it checks |
|----------|---------|----------------|
| **CI** | Push to `main`, PRs | Frontend tests (all 3 platforms), TypeScript type check, build |
| **Lint** | Push to `main`, PRs | Biome (TypeScript/React) |

### PR Requirements

Before a PR can be merged:

1. All CI checks must pass (green checkmarks)
2. Frontend tests pass on all three platforms (Ubuntu, Windows, macOS)
3. Linting passes (no Biome errors)
4. TypeScript type checking passes

### Running CI Checks Locally

```bash
cd apps/desktop
npm test
npm run lint
npm run typecheck
```

## Git Workflow

This fork uses a **trunk-based** workflow. Branch from `zeenha`, open a pull request back into `zeenha`, and a human merges it once CI passes.

### Working with Forks

If you contribute from your own fork of `elshazlyhefny/Aperant`, configure it carefully to avoid sync issues.

#### Initial Fork Setup

```bash
# 1. Fork elshazlyhefny/Aperant on GitHub (click the Fork button on the repo page)

# 2. Clone YOUR fork (not the original repo)
git clone https://github.com/YOUR-USERNAME/Aperant.git
cd Aperant

# 3. Verify your remotes point to YOUR fork
git remote -v
# Should show:
# origin  https://github.com/YOUR-USERNAME/Aperant.git (fetch)
# origin  https://github.com/YOUR-USERNAME/Aperant.git (push)

# 4. Add this fork's repo as the upstream remote to sync with it
git remote add upstream https://github.com/elshazlyhefny/Aperant.git

# 5. Make gh target the fork, not AndyMik90/Aperant
gh repo set-default elshazlyhefny/Aperant
```

#### Keeping Your Fork Updated

```bash
# Fetch latest changes from upstream (elshazlyhefny/Aperant)
git fetch upstream

# Sync your local zeenha branch
git checkout zeenha
git merge --ff-only upstream/zeenha
```

#### Converting a Fork to Standalone

> ⚠️ **Common Issue:** After making a fork standalone (e.g., disconnecting from the original repo on GitHub), your local git configuration may still reference the original forked repository, causing push/pull issues.

If you convert your fork to a standalone repository:

```bash
# 1. Update origin to point to your standalone repo
git remote set-url origin https://github.com/YOUR-USERNAME/Your-Standalone-Repo.git

# 2. Remove the upstream remote (no longer applicable)
git remote remove upstream

# 3. Verify your configuration
git remote -v
# Should only show your standalone repo as origin

# 4. Update your default branch tracking if needed
git branch --set-upstream-to=origin/zeenha zeenha
```

#### Troubleshooting Fork Issues

| Problem | Cause | Solution |
|---------|-------|----------|
| `Permission denied` on push | Origin points to upstream repo | `git remote set-url origin <your-fork-url>` |
| `Repository not found` | Fork was deleted or made standalone | Update remote URL to current repo location |
| Can't push your branch | Local branch tracks wrong remote | `git branch --set-upstream-to=origin/zeenha zeenha` |
| `gh pr create` targets the wrong repo | `gh` picked the `upstream` remote | `gh repo set-default elshazlyhefny/Aperant` |
| Commits show wrong author | Git config not set | `git config user.email "you@example.com"` |

### Branch Overview

```
zeenha (trunk)         ← Default branch - all PRs merge here
  │
├── feature/xxx        ← New features
├── fix/xxx            ← Bug fixes
├── docs/xxx           ← Documentation
└── ...                ← See Branch Naming
```

### Main Branches

| Branch | Purpose | Protected |
|--------|---------|-----------|
| `zeenha` | Trunk. Every feature and fix lands here through a pull request, and releases are cut from it. | ✅ Yes |

> ⚠️ Upstream's frozen `develop` branch is a copy of the old upstream state. Never branch from it or target it.

### Supporting Branches

| Branch Type | Branch From | Merge To | Purpose |
|-------------|-------------|----------|---------|
| `feature/*` | `zeenha` | `zeenha` | New features and enhancements |
| `fix/*` | `zeenha` | `zeenha` | Bug fixes |
| `docs/*`, `refactor/*`, `test/*`, `chore/*` | `zeenha` | `zeenha` | Other changes |

Upstream's `release/*` and `hotfix/*` branches are upstream-only and are not used in this fork.

### Branch Naming

Use descriptive branch names with a prefix indicating the type of change:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feature/` | New feature | `feature/add-dark-mode` |
| `fix/` | Bug fix | `fix/memory-leak-in-worker` |
| `docs/` | Documentation | `docs/update-readme` |
| `refactor/` | Code refactoring | `refactor/simplify-auth-flow` |
| `test/` | Test additions/fixes | `test/add-integration-tests` |
| `chore/` | Maintenance tasks | `chore/update-dependencies` |

### Where to Branch From

```bash
# For every change - ALWAYS branch from zeenha
git checkout zeenha
git pull origin zeenha
git checkout -b feature/my-new-feature
```

### Pull Request Targets

> ⚠️ **Important:** All PRs must target `zeenha`. Never target upstream's frozen `develop` branch, and never open anything against `AndyMik90/Aperant`.

| Your Branch Type | Target Branch |
|------------------|---------------|
| `feature/*` | `zeenha` |
| `fix/*` | `zeenha` |
| `docs/*` | `zeenha` |
| `refactor/*` | `zeenha` |
| `test/*` | `zeenha` |
| `chore/*` | `zeenha` |


### Releases (Maintainers)

Releases of this fork use `scripts/zeenha-release.sh`. It is run by a human only: it tests, builds, pushes and installs the next `zeenha.N`. See [RELEASE.md](RELEASE.md).

```bash
scripts/zeenha-release.sh             # test, build, push, install the next zeenha.N
scripts/zeenha-release.sh --rollback  # go back to the previous install
```

> ⚠️ **Note:** The old upstream release, beta and hotfix flow (`release/*` and `hotfix/*` branches, the Beta Release workflow) no longer applies here. Contributors never cut releases: merge to `zeenha` and a maintainer releases from there.


### Commit Messages

Write clear, concise commit messages that explain the "why" behind changes:

```bash
# Good
git commit -m "Add retry logic for failed API calls

Implements exponential backoff for transient failures.
Fixes #123"

# Avoid
git commit -m "fix stuff"
git commit -m "WIP"
```

**Format:**
```
<type>: <subject>

<body>

<footer>
```

- **type**: feat, fix, docs, style, refactor, test, chore
- **subject**: Short description (50 chars max, imperative mood)
- **body**: Detailed explanation if needed (wrap at 72 chars)
- **footer**: Reference issues, breaking changes

### PR Hygiene

**Rebasing:**
- **Rebase onto zeenha** before opening a PR and before merge to maintain linear history
- Use `git fetch origin && git rebase origin/zeenha` to sync your branch
- Use `--force-with-lease` when force-pushing rebased branches (safer than `--force`)
- Notify reviewers after force-pushing during active review
- **Exception:** Never rebase after PR is approved and others have reviewed specific commits

**Commit organization:**
- **Squash fixup commits** (typos, "oops", review feedback) into their parent commits
- **Keep logically distinct changes** as separate commits that could be reverted independently
- Each commit should compile and pass tests independently
- No "WIP", "fix tests", or "lint" commits in final PR - squash these

**Before requesting review:**
```bash
# Ensure up-to-date with zeenha
git fetch origin && git rebase origin/zeenha

# Clean up commit history (squash fixups, reword messages)
git rebase -i origin/zeenha

# Force push with safety check
git push --force-with-lease

# Verify everything works
cd apps/desktop && npm test && npm run lint && npm run typecheck
```

**PR size:**
- Keep PRs small (<400 lines changed ideally)
- Split large features into stacked PRs if possible

## Pull Request Process

1. **Fork the repository** and create your branch from `zeenha`

   ```bash
   git checkout zeenha
   git pull origin zeenha
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the code style guidelines

3. **Test thoroughly**:
   ```bash
   cd apps/desktop && npm test && npm run lint && npm run typecheck
   ```

4. **Update documentation** if your changes affect:
   - Public APIs
   - Configuration options
   - User-facing behavior

5. **Create the Pull Request**:
   - Use a clear, descriptive title
   - Reference any related issues
   - Describe what changes you made and why
   - Include screenshots for UI changes
   - List any breaking changes

6. **PR Title Format**:
   ```
   <type>: <description>
   ```
   Examples:
   - `feat: Add support for custom prompts`
   - `fix: Resolve memory leak in worker process`
   - `docs: Update installation instructions`

7. **Review Process**:
   - Address reviewer feedback promptly
   - Keep the PR focused on a single concern
   - Squash commits if requested

## Issue Reporting

### Bug Reports

When reporting a bug, include:

1. **Clear title** describing the issue
2. **Environment details**:
   - OS and version
   - Node.js version
   - Auto Claude version
3. **Steps to reproduce** the issue
4. **Expected behavior** vs **actual behavior**
5. **Error messages** or logs (if applicable)
6. **Screenshots** (for UI issues)

### Feature Requests

When requesting a feature:

1. **Describe the problem** you're trying to solve
2. **Explain your proposed solution**
3. **Consider alternatives** you've thought about
4. **Provide context** on your use case

## Architecture Overview

Auto Claude is a single Electron desktop application in `apps/desktop/`.

### Electron Desktop (`apps/desktop/`)

- **AI Agent Layer** (`src/main/ai/`) - Vercel AI SDK v6 agent runtime, providers, tools, security, orchestration
- **Main Process** (`src/main/`) - IPC handlers, agent queue, terminal management, claude-profile
- **Renderer** (`src/renderer/`) - React UI components and Zustand stores
- **Shared** (`src/shared/`) - Types, i18n locales, constants, utilities

For detailed architecture information, see [CLAUDE.md](CLAUDE.md).

---

## Questions?

If you have questions about contributing, feel free to:

1. Open a GitHub issue with the `question` label
2. Review existing issues and discussions

Thank you for contributing to Auto Claude!
