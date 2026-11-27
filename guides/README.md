# Aperant Guides

Detailed documentation for Aperant setup and usage.

## Integration capabilities

This table covers AI review, issue import and outcome write-back. For separate workflows, see [Creating pull requests](creating-pull-requests.md) and [PR follow-ups](pr-follow-ups.md). For setup, see [Project configuration](project-configuration.md) and [Issue write-back](issue-writeback.md).

<!-- INTEGRATION_CAPABILITIES_START -->

| Provider / edition | AI PR/MR review | Issue / work-item import | Desktop outcome write-back | Headless run/serve outcome write-back | Optional move on `review_ready` | Setup / limits |
| --- | --- | --- | --- | --- | --- | --- |
| GitHub (github.com) | Desktop | Desktop | Comment | Comment | None | [Project setup](project-configuration.md#github) · [Write-back](issue-writeback.md#turn-it-on) |
| GitLab (GitLab.com or a configured self-managed instance) | Desktop | Desktop | Note | Note | None | [Project setup](project-configuration.md#gitlab) · [Write-back](issue-writeback.md#turn-it-on) |
| Linear | Unsupported | Desktop | Comment | Comment | State — Desktop | [Project setup](project-configuration.md#linear) · [Write-back](issue-writeback.md#turn-it-on) |
| Jira (Cloud only) | Unsupported | Desktop | Comment | Comment | Status — Desktop, Headless run/serve | [Project setup](project-configuration.md#jira) · [Write-back](issue-writeback.md#turn-it-on) |
| Bitbucket Cloud | Desktop | Unsupported | Unsupported | Unsupported | None | [Project setup](project-configuration.md#bitbucket) · [AI review](project-configuration.md#ai-review) |
| Bitbucket Server | Unsupported | Unsupported | Unsupported | Unsupported | None | [Edition limits](project-configuration.md#bitbucket) |
| Bitbucket Data Center | Unsupported | Unsupported | Unsupported | Unsupported | None | [Edition limits](project-configuration.md#bitbucket) |
| Azure DevOps Services | Desktop | Unsupported | Unsupported | Unsupported | None | [Project setup](project-configuration.md#azure-devops) · [AI review](project-configuration.md#azure-devops-ai-review) |
| Azure Boards (Services) | Unsupported | Desktop | Comment | Comment | State — Desktop, Headless run/serve | [Project setup](project-configuration.md#azure-devops) · [Import](project-configuration.md#import-work-items-from-azure-boards) · [Write-back](issue-writeback.md#turn-it-on) |
| Azure DevOps Server | Unsupported | Unsupported | Unsupported | Unsupported | None | [Edition limits](project-configuration.md#azure-devops) |

**Legend:** Desktop means the desktop app only. Unsupported means the feature is not available on the listed edition or surface.
Outcome write-back is opt-in and targets the imported issue or work item, not the PR/MR. Headless `run`/`serve` uses existing import metadata; it does not import issues.
Status/state moves are optional and only available on the surfaces listed.

<!-- INTEGRATION_CAPABILITIES_END -->

**Contributors:** [integration-capabilities.json](integration-capabilities.json) is the source of truth for both indexes. After editing it, run `node scripts/update-integration-capabilities.mjs --write` from the repo root. Update the capability test fixtures when verified support changes.

## Available Guides

| Guide | Description |
|-------|-------------|
| **[CLI-USAGE.md](CLI-USAGE.md)** | Terminal-only usage for power users, headless servers, and CI/CD |
| **[windows-development.md](windows-development.md)** | Windows-specific development guide (file encoding, paths, line endings) |
| **[linux.md](linux.md)** | Linux-specific installation and build guide (Flatpak, AppImage) |
| **[project-configuration.md](project-configuration.md)** | Reference for the per-project `.aperant.json` and `.auto-claude/.env` files |
| **[task-dependencies.md](task-dependencies.md)** | How tasks wait for other tasks, when a dependency counts as finished, and planned file overlap warnings |
| **[notifications-and-webhooks.md](notifications-and-webhooks.md)** | Desktop notifications and the task-outcome webhook: events, payload, URL rules and retries, including headless `cli.js run` |
| **[issue-writeback.md](issue-writeback.md)** | Set up and troubleshoot opt-in task outcome write-back on imported issues or work items |
| **[recurring-tasks.md](recurring-tasks.md)** | Recurring task schedules: cadences, when they run, and what missed and skipped runs mean |
| **[token-budgets.md](token-budgets.md)** | Project default and per-task token budgets, what counts, what happens at the limit, schedules, and how the CLI differs |
| **[pr-follow-ups.md](pr-follow-ups.md)** | Sending a task's failing CI checks and unresolved review comments back to the agent: when the panel shows, what is listed, how QA checks the fix and Aperant pushes it, and why the panel can be disabled |
| **[delivery-metrics.md](delivery-metrics.md)** | How to read the Delivery cards, including which tasks the period selects, how missing or unreadable metrics and errored tasks count, and how to check a task's contribution in its Usage tab |
| **[usage-and-account-switching.md](usage-and-account-switching.md)** | The usage monitor, what each provider reports, the automatic account switching settings and their defaults, proactive versus reactive switching, the pending-auth indicator and troubleshooting |
| **[creating-pull-requests.md](creating-pull-requests.md)** | How **Create PR** picks the forge, builds the title and body, and handles existing pull requests |

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
