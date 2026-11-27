# Issue Write-Back

Aperant can post a short comment on the issue a task was imported from when the task is ready for review, fails, or is blocked. It works for GitHub, GitLab, Linear, Jira and Azure Boards issues. For Jira it can also move the issue to another status, and for Azure Boards it can move the work item to another state. This guide covers which tasks qualify, how to turn it on, the exact comment text, which credentials are used, and how delivery behaves.

> **Warning:** Nothing is posted unless you turn it on. Every switch is off by default, except Jira's **Post a comment**, which does nothing until **Enable Jira write-back** is on. Issue trackers are usually shared, so a comment is visible to everyone who can read the issue. The comment is posted with the project's own import credentials (see [Credentials and logging](#credentials-and-logging)).

## Which tasks qualify

Only tasks that were imported from an issue get a comment. Aperant reads the `sourceType` key of the task's `task_metadata.json` in its spec directory. The directory is looked up in the project's specs directory and, when the task has a worktree, in the worktree's specs directory too.

| `sourceType` | Provider |
|--------------|----------|
| `github` | GitHub |
| `gitlab` | GitLab |
| `linear` | Linear |
| `jira` | Jira |
| `azure_boards` | Azure Boards |

Bitbucket Cloud issues are not supported. Aperant cannot import issues from Bitbucket, so no task has a Bitbucket issue to comment on, and Bitbucket's built-in issue tracker is per repository and often switched off. If your team uses Bitbucket for code and Jira for tracking, the outcome comment goes on the task's Jira ticket (see the Jira rows above and below).

Tasks created by hand (`manual`) or from the roadmap, ideation, insights or a schedule get no comment. Only the one issue the task was imported from is touched.

Each provider also has guards. All of them must hold, or nothing is posted:

| Provider | What the task metadata must contain | What it is checked against |
|----------|-------------------------------------|----------------------------|
| GitHub | `githubIssueNumber`, a positive integer, and `githubUrl` | The URL must be on `github.com`, and its owner and repository must equal the project's configured repository (compared case-insensitively). |
| GitLab | `gitlabIssueIid`, a positive integer, and `gitlabUrl` | The URL must be on the same host as the project's configured GitLab instance. |
| Linear | `linearIssueId`: letters, digits, `_` and `-`, up to 100 characters | The project needs a `LINEAR_API_KEY`. |
| Jira | `jiraIssueKey`, a valid issue key, and `jiraSiteUrl` | The site must equal the project's configured Jira site. |
| Azure Boards | `azureBoardsWorkItemId`, a positive integer, `azureBoardsOrganization` and `azureBoardsProject` | The organization and project must equal `AZURE_DEVOPS_ORGANIZATION` and `AZURE_DEVOPS_PROJECT` (compared case-insensitively). |

A task imported while the project pointed at a different repository, instance or site than it does now is skipped.

## When it fires

Write-back follows the same task states as the webhook (see [Events](notifications-and-webhooks.md#events)):

| Task state | Event | Comment first line |
|------------|-------|--------------------|
| Status `error` | `failed` | `Aperant: task failed.` |
| Human review, reason `completed` | `review_ready` | `Aperant: task is ready for review.` |
| Human review, reason `qa_rejected` or `errors` | `blocked` | `Aperant: task is blocked and needs attention.` |
| Human review, reason `account_required` (paused: no usable account for a phase's provider) | none | none |
| Any other state | none | none |

One comment is posted each time a task moves into one of these states. `pr_opened` is never written back (see [Why PR opened is webhook-only](#why-pr-opened-is-webhook-only)). An account pause (`account_required`) is never written back either, and is never reported as `failed`: every Resume without a usable account pauses the task again, and each pause would post another public comment. The webhook still reports it (see [Events](notifications-and-webhooks.md#events)).

## Turn it on

Open **Settings > App Settings > Notifications**. The write-back blocks are below the **Task outcome webhook** block.

**Issue write-back** has one switch per provider:

| Switch | Default |
|--------|---------|
| **GitHub issues** | Off |
| **GitLab issues** | Off |
| **Linear issues** | Off |
| **Azure Boards work items** | Off |

**Jira write-back** has its own block:

| Control | Default | Effect |
|---------|---------|--------|
| **Enable Jira write-back** | Off | Master switch. Nothing is sent to Jira while it is off. |
| **Post a comment** | On | Posts the comment. It matters only once Jira write-back is enabled. |
| **Move issue when ready for review** | Off | Moves the issue to the status named below. |
| **Target status name** | `In Review` | The status to move to. It can be edited only while the move switch is on. |

**Azure Boards work items** is a switch in the same block, off by default. It has its own move controls:

| Control | Default | Effect |
|---------|---------|--------|
| **Move work item when ready for review** | Off | Moves the work item to the state named below. |
| **Target state name** | `Resolved` | The state to move to. |

Azure Boards move rules:

- The move happens only on `review_ready`, and only when the state name is not empty.
- If Azure Boards does not know the state, or the work item's process does not allow the change, the failure is logged as `[IssueWriteback] azureboards transition failed event=... issue=#<id> reason=...`. The comment and the task are not affected.

Jira move rules:

- The move happens only on `review_ready`, and only when the status name is not empty.
- The name is matched, ignoring case and surrounding spaces, against the statuses the issue can move to right now, through the issue's available workflow transitions.
- If no available transition leads to that status, nothing happens and no error is reported. The comment is not affected.
- The comment and the move are independent. With the comment off and the move on, only the move is attempted. With both off, nothing is sent.

Other points:

- These settings are app-wide, not per project.
- They are stored only in the app's `settings.json`, never in `.aperant.json` or `.auto-claude/.env`. The reasoning is the same as for the webhook (see [Security: user-level only](notifications-and-webhooks.md#security-user-level-only)): a repository must not be able to switch on posting to a tracker.
- A missing or non-boolean value falls back to the default.
- The write-back toggles are independent of the webhook toggles and of desktop notifications.

## What the comment says

The comment is plain text. The first line is fixed by the event, and two optional lines follow:

```
<fixed first line>
Task: <title>
Pull request: <url>
```

| Line | Content |
|------|---------|
| First line | `Aperant: task is ready for review.`, `Aperant: task failed.` or `Aperant: task is blocked and needs attention.` |
| `Task: <title>` | The task title. Control characters (U+0000 to U+001F and U+007F to U+009F) become a space, and the result is trimmed. A title longer than 200 characters is cut to 199 characters followed by an ellipsis. The line is left out when the title is empty. |
| `Pull request: <url>` | Added only when the task has a PR URL that is a valid `https://` URL without embedded credentials (the same rule as the webhook link). Otherwise the line is left out. |

A task that is ready for review and has a PR:

```
Aperant: task is ready for review.
Task: Add login page
Pull request: https://github.com/acme/my-app/pull/42
```

A failed task without a PR:

```
Aperant: task failed.
Task: Add login page
```

What is not included: error text, file paths, branch names, code, logs and task ids. The text is the same for every provider, Jira included. Azure Boards HTML-escapes the comment, so the text may show escaped characters in the work item discussion.

## Why PR opened is webhook-only

The `review_ready` comment already carries the PR link when the task has one. A separate comment when the PR is created would put a second comment on the issue. For this reason `pr_opened` is sent only by the webhook (see [Events](notifications-and-webhooks.md#events)) and is ignored by issue write-back.

## Credentials and logging

Write-back reuses the credentials the project already uses to import issues, from `.auto-claude/.env`:

| Provider | Keys used |
|----------|-----------|
| GitHub | `GITHUB_TOKEN` and the configured repository |
| GitLab | `GITLAB_TOKEN` and the configured project and instance URL |
| Linear | `LINEAR_API_KEY` |
| Jira | `JIRA_SITE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` |
| Azure Boards | `AZURE_DEVOPS_ORGANIZATION`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_REPOSITORY` and `AZURE_DEVOPS_PAT` |

See [Per-Project Configuration](project-configuration.md), in particular the [Jira](project-configuration.md#jira) section and [Secrets](project-configuration.md#secrets). No extra credentials are requested.

The token must be allowed to comment on issues. For Jira, moving an issue also needs permission to transition it. The Azure DevOps PAT needs the Work Items (Read & write) scope, which is more than the scopes needed for pull requests. The comment appears under the account that owns the token, so teammates see it as posted by that user.

Logging:

- The text of the comment is not logged. The token, the request body and the response text are never logged.
- When a post fails, one warning line is written to the app log with the provider, the event, the issue reference and the reason. The reason is an error name, with the HTTP status added for GitLab and Jira API errors (for Jira API errors the error message is used in place of the name). The formats are:

```
[IssueWriteback] <provider> comment failed event=<event> issue=<ref> reason=<...>
[JiraWriteback] comment failed event=<event> issue=<key> reason=<...>
[JiraWriteback] transition failed event=<event> issue=<key> reason=<...>
[IssueWriteback] azureboards transition failed event=<event> issue=#<id> reason=<...>
```

For GitHub, GitLab and Azure Boards the issue reference is `#<number>`. For Linear it is the issue id. For Jira it is the issue key.

## Delivery

- Write-back runs in the background after the status change. It is fire-and-forget.
- There is one attempt. There is no retry and no queue. A comment that fails is dropped.
- It never changes a task's status and never blocks the app.
- Delivery errors do not affect task flow. **Task Detail → Overview → Delivery history** shows the comment result separately from the result of any enabled issue state change. A failed comment does not stop an eligible state change, and a state-change failure does not alter the comment receipt.
- The headless commands (`cli.js run` and `cli.js serve`) also post issue comments, when their `--config` file turns write-back on. See [CLI-USAGE.md](CLI-USAGE.md).

The [delivery history guide](notifications-and-webhooks.md#delivery-history) explains each status and the local retention limit. Use the [read-only CLI history command](CLI-USAGE.md#delivery-receipts) after a headless run. An unconfirmed write may already have reached the tracker; check the issue before posting manually. Neither receipt reads nor restarts replay a comment or state change.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| No comment is posted | The switch for that provider is off. For Jira, **Enable Jira write-back** is off. | Turn it on in **Settings > App Settings > Notifications**. |
| No comment on a task | The task was created by hand or from the roadmap, ideation, insights or a schedule, so it has no imported `sourceType`. | Only imported tasks get comments. Import the issue as a task. |
| No comment on an imported task | `task_metadata.json` is missing or unreadable, for example because the spec directory was removed. | Check that the file exists in the task's spec directory and holds valid JSON. |
| No comment on an imported task | A metadata key is missing or malformed (for example the issue number or key, or the URL). | Check the keys listed in [Which tasks qualify](#which-tasks-qualify). |
| No comment on an imported task | The task was imported from a repository, instance or site other than the project's current configuration. | Point the project back at the original repository, instance or site, or accept that the task is skipped. |
| No comment, and a warning line in the app log | Credentials are missing, or the token cannot comment on the issue. | Check the keys in `.auto-claude/.env` and the token's permissions. Read the `reason=` in the log line. |
| Jira comment appears but the issue does not move | The target status name matches no transition available to the issue right now. Nothing is logged for this case. | Use a status name the issue can reach from its current status, and check the spelling. |
| Azure Boards comment fails with an authorization error | The PAT lacks the Work Items (Read & write) scope. | Create a PAT with that scope and update `AZURE_DEVOPS_PAT`. |
| Azure Boards comment appears but the work item does not move | The target state is unknown or not allowed for the work item type. A `transition failed` line is in the app log. | Use a state the work item can reach, and check the spelling. |
| No comment when the PR is opened | `pr_opened` is webhook-only. | Expect the comment when the task is ready for review. The link is in that comment. |

What to check first: the toggle, then the task's metadata, then the credentials, then the app log.
