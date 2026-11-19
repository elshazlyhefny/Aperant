# forge/

The seam between PR feedback / outcome writeback and the services behind them.
`task/pr-feedback-source.ts` and `issue-writeback/issue-writeback.ts` only talk
to the registry here. They never name a provider.

## Interfaces (`types.ts`)

- `OutcomeWriter`: posts a task outcome comment to the issue a task came from.
  It has a `sourceType` (matches `task_metadata.json`), an optional
  `settingKey` (the opt-in flag in `IssueWritebackSettings`), an optional
  `isEnabled(raw)` hook and `postOutcome()`, which is fire-and-forget and
  never throws. A tracker that keeps its own settings block (Jira's
  `jiraWriteback`) omits `settingKey` and implements `isEnabled(raw)` to read
  the raw app settings; without it, `issueWriteback[settingKey]` is used.
- `PRHost`: a code host's pull requests. It resolves its PR/MR URLs
  (`resolvePR`), loads CI and review feedback (`loadFeedback`) and has a
  `notConfiguredMessage`.
- `Forge`: a `PRHost` that is also an `OutcomeWriter` (GitHub, GitLab).
  Bitbucket and Azure DevOps PRs are `PRHost` only: they have PR feedback but no
  issue writeback, so the registry does not list them as writers (see
  [Not planned: Bitbucket issue writeback](#not-planned-bitbucket-issue-writeback)).
- Linear, Jira and Azure Boards are writeback-only trackers (`OutcomeWriter` only,
  no PRs). Azure Boards (`azureboards-writer.ts`, `sourceType` `azure_boards`)
  has its toggle and state-transition settings in `IssueWritebackSettings`.

## Not planned: Bitbucket issue writeback

Bitbucket stays `PRHost` only. Reasons:

- Bitbucket Cloud teams almost always track work in Jira, which already has
  import (task 045) and an `OutcomeWriter` (task 134, `jira-writer.ts`).
- Bitbucket's built-in issue tracker is per repository and widely disabled.
- The app has no Bitbucket issue import, so no task would have a Bitbucket
  issue `sourceType` to write back to.

Reopen only if users ask for Bitbucket issue import. Do the import first, then
add a `bitbucket-writer.ts` following `github-writer.ts` and a registry entry
in the extra writers list.

## Electron-free writers

`github-writer.ts`, `gitlab-writer.ts`, `linear-writer.ts`, `jira-writer.ts` and
`azureboards-writer.ts`
hold the outcome writers without importing Electron. `github-forge.ts` /
`gitlab-forge.ts` build their `postOutcome` from the factories with the desktop
config resolvers (gh/glab token fallback), and `jira/jira-writeback.ts` builds
the desktop Jira writer with a loader that reads the settings file.
`headless-writers.ts` builds the CLI set from `.env` plus the process
environment, with the Jira settings from the CLI config. Both sides dispatch
through `issue-writeback/issue-writeback-core.ts`. `postOutcome` returns a promise that never rejects, so
headless callers can await it.

## Adding a provider

1. Create one file in `forge/` (e.g. `bitbucket-forge.ts`) implementing `Forge`
   (or just `PRHost` for a code host with no issue writeback, or just
   `OutcomeWriter` for an issue tracker with no PRs).
2. Add it to `FORGES` in `registry.ts` (trackers go in the extra writers list).
   Order matters: the first forge whose `resolvePR` matches a URL wins.
3. If the provider needs its own writeback toggle, add the key to
   `IssueWritebackSettings` in `shared/types/settings.ts` and use it as `settingKey`.
   A provider with its own settings block implements `isEnabled` instead of
   adding a key to `IssueWritebackSettings`.

## The `not_configured` error code

When a forge has no usable credentials, `loadFeedback` returns
`{ ok: false, code: 'not_configured', error }`. The IPC layer maps it with
`notConfiguredBlockedReason(provider)` (`shared/types/pr-feedback.ts`): if a
per-provider code `no_<provider>_config` exists (GitHub, GitLab, Bitbucket,
Azure DevOps) that
is returned so existing UI keeps working; otherwise the generic `not_configured`
is used. The error text is the forge's own (`error`), so a PR on another
repository gets its specific message.
