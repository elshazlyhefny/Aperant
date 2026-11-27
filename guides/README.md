# Aperant Guides

Detailed documentation for Aperant setup and usage.

## Available Guides

| Guide | Description |
|-------|-------------|
| **[CLI-USAGE.md](CLI-USAGE.md)** | Terminal-only usage for power users, headless servers, and CI/CD |
| **[windows-development.md](windows-development.md)** | Windows-specific development guide (file encoding, paths, line endings) |
| **[linux.md](linux.md)** | Linux-specific installation and build guide (Flatpak, AppImage) |
| **[project-configuration.md](project-configuration.md)** | Reference for the per-project `.aperant.json` and `.auto-claude/.env` files |
| **[task-dependencies.md](task-dependencies.md)** | How tasks wait for other tasks, when a dependency counts as finished, and planned file overlap warnings |
| **[notifications-and-webhooks.md](notifications-and-webhooks.md)** | Desktop notifications and the task-outcome webhook: events, payload, URL rules and retries, including headless `cli.js run` |
| **[issue-writeback.md](issue-writeback.md)** | The comment Aperant can post on the Jira, GitHub, GitLab, Linear or Azure Boards issue a task was imported from: the opt-in switches, the exact comment text and troubleshooting |
| **[recurring-tasks.md](recurring-tasks.md)** | Recurring task schedules: cadences, when they run, and what missed and skipped runs mean |
| **[token-budgets.md](token-budgets.md)** | Project default and per-task token budgets, what counts, what happens at the limit, schedules, and how the CLI differs |
| **[pr-follow-ups.md](pr-follow-ups.md)** | Sending a task's failing CI checks and unresolved review comments back to the agent: when the panel shows, what is listed, how QA checks the fix and Aperant pushes it, and why the panel can be disabled |
| **[delivery-metrics.md](delivery-metrics.md)** | How to read the Delivery cards, including which tasks the period selects, how missing or unreadable metrics and errored tasks count, and how to check a task's contribution in its Usage tab |
| **[usage-and-account-switching.md](usage-and-account-switching.md)** | The usage monitor, what each provider reports, the automatic account switching settings and their defaults, proactive versus reactive switching, the pending-auth indicator and troubleshooting |
| **[creating-pull-requests.md](creating-pull-requests.md)** | How **Create PR** picks the forge (GitHub, GitLab, Bitbucket Cloud or Azure DevOps), when it falls back to GitHub, how the title and body are built, and what happens when a pull request already exists |

## Internal notes

These are developer write-ups of fixed bugs, not user guides.

| Note | Description |
|------|-------------|
| **[cross-project-projectid-tracking.md](cross-project-projectid-tracking.md)** | Cross-project task contamination: missing projectId in the agent event pipeline |
| **[pr-1575-fixes.md](pr-1575-fixes.md)** | Follow-up fixes after the XState task state machine migration (PR #1575) |

## Quick Links

- [Main README](../README.md) - Getting started (install from source)
- [Contributing](../CONTRIBUTING.md) - How to contribute and run from source
- [Changelog](../CHANGELOG.md) - Release history
