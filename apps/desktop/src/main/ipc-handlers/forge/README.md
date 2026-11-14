# forge/

The seam between PR feedback / outcome writeback and the services behind them.
`task/pr-feedback-source.ts` and `issue-writeback/issue-writeback.ts` only talk
to the registry here. They never name a provider.

## Interfaces (`types.ts`)

- `OutcomeWriter`: posts a task outcome comment to the issue a task came from.
  It has a `sourceType` (matches `task_metadata.json`), a `settingKey` (the
  opt-in flag in `IssueWritebackSettings`) and `postOutcome()`, which is
  fire-and-forget and never throws.
- `PRHost`: a code host's pull requests. It resolves its PR/MR URLs
  (`resolvePR`), loads CI and review feedback (`loadFeedback`) and has a
  `notConfiguredMessage`.
- `Forge`: a `PRHost` that is also an `OutcomeWriter` (GitHub, GitLab).
  Bitbucket and Azure DevOps are `PRHost` only: they have PR feedback but no
  issue writeback, so the registry does not list them as writers.

## Adding a provider

1. Create one file in `forge/` (e.g. `bitbucket-forge.ts`) implementing `Forge`
   (or just `PRHost` for a code host with no issue writeback, or just
   `OutcomeWriter` for an issue tracker with no PRs).
2. Add it to `FORGES` in `registry.ts` (trackers go in the extra writers list).
   Order matters: the first forge whose `resolvePR` matches a URL wins.
3. If the provider needs its own writeback toggle, add the key to
   `IssueWritebackSettings` in `shared/types/settings.ts` and use it as `settingKey`.

## The `not_configured` error code

When a forge has no usable credentials, `loadFeedback` returns
`{ ok: false, code: 'not_configured', error }`. The IPC layer maps it with
`notConfiguredBlockedReason(provider)` (`shared/types/pr-feedback.ts`): if a
per-provider code `no_<provider>_config` exists (GitHub, GitLab, Bitbucket,
Azure DevOps) that
is returned so existing UI keeps working; otherwise the generic `not_configured`
is used. The error text is the forge's own (`error`), so a PR on another
repository gets its specific message.
