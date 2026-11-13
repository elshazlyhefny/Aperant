# Auto Claude Guides

Detailed documentation for Auto Claude setup and usage.

## Available Guides

| Guide | Description |
|-------|-------------|
| **[CLI-USAGE.md](CLI-USAGE.md)** | Terminal-only usage for power users, headless servers, and CI/CD |
| **[windows-development.md](windows-development.md)** | Windows-specific development guide (file encoding, paths, line endings) |
| **[linux.md](linux.md)** | Linux-specific installation and build guide (Flatpak, AppImage) |
| **[project-configuration.md](project-configuration.md)** | Reference for the per-project `.aperant.json` and `.auto-claude/.env` files |
| **[task-dependencies.md](task-dependencies.md)** | How tasks wait for other tasks, when a dependency counts as finished, and planned file overlap warnings |
| **[notifications-and-webhooks.md](notifications-and-webhooks.md)** | Desktop notifications and the task-outcome webhook: events, payload, URL rules and retries |
| **[recurring-tasks.md](recurring-tasks.md)** | Recurring task schedules: cadences, when they run, and what missed and skipped runs mean |
| **[token-budgets.md](token-budgets.md)** | Project default and per-task token budgets, what counts, what happens at the limit, schedules, and how the CLI differs |
| **[pr-follow-ups.md](pr-follow-ups.md)** | Sending a task's failing CI checks and unresolved review comments back to the agent: when the panel shows, what is listed, how QA checks the fix and Aperant pushes it, and why the panel can be disabled |

## Quick Links

- [Main README](../README.md) - Getting started (download and install)
- [Contributing](../CONTRIBUTING.md) - How to contribute and run from source
- [Changelog](../CHANGELOG.md) - Release history
