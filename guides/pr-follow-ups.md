# PR Follow-ups

When a task has a pull request, the task detail modal shows a **PR feedback** panel. It lists the failed CI checks and the open review feedback on that pull request. You pick the items you want fixed and send them to the task's agent. The agent fixes them in the task's own worktree. After QA approves the fix, Aperant pushes it to the same branch, so the existing pull request updates. No new pull request is created.

This works for GitHub, GitLab, Bitbucket Cloud and Azure DevOps. The panel reads feedback through the API of the forge that hosts the pull request (merge request on GitLab). The headless CLI is not covered. See [Not covered](#not-covered). The panel text is available in English and French.

## When the panel appears

Open a task and look at its detail modal. The **PR feedback** panel shows when both of these are true:

- The task has a pull request URL (`metadata.prUrl`).
- The task status is `pr_created` or `done`.

Otherwise the panel is hidden.

After a follow-up is pushed, the task goes back to `done` with the pull request still open. The panel stays available for the next round of feedback.

## What is listed

The panel groups feedback into three lists.

| Group | What it contains |
|-------|------------------|
| **Failed checks** | Check runs that are completed with the conclusion `failure`, `timed_out`, `cancelled`, `action_required` or `startup_failure`. Legacy commit statuses in state `failure` or `error` are also listed. |
| **Unresolved review comments** | Review threads that are not resolved. Outdated threads are included and their title ends with `(outdated)`. |
| **Change requests** | Reviews in state `CHANGES_REQUESTED` that have a non-empty body. |

Limits:

- At most 50 items per group.
- At most 5 comments per review thread.
- At most 4000 characters per item. A longer item is cut and marked as truncated.
- Titles are cut at 300 characters.
- Check runs are read for the head commit of the pull request only. Aperant reads 100 check runs and does not fetch further pages.

Text that looks like a GitHub token or an API key is replaced with `[redacted]` before it is shown.

If a pull request has more than 50 items in a group, only the first 50 show. Fix some of them, then click **Refresh**. The next load lists the remaining items.

## Sending feedback to the agent

1. Open the task from the Kanban board.
2. Read the **PR feedback** panel. Use **Open in browser** on an item to see it in context.
3. Tick the items you want fixed. Nothing is pre-selected.
4. Click **Send selected to agent**.

The panel then shows: "Follow-up started. The agent will push to the pull request only after QA approves."

What Aperant does next:

1. The main process loads the feedback from GitHub again. It builds the request itself from the IDs of the items you ticked. The text you saw in the panel is not what is sent.
2. It writes `PR_FOLLOWUP.json` and `QA_FIX_REQUEST.md` into the spec directory of the task's worktree.
3. It starts the QA process in the same worktree (`agentManager.startQAProcess`).
4. The agent fixes the items. Its instructions tell it not to push.
5. QA reviews the changes.
6. Only after a fresh QA approval does Aperant push to the same branch.

### When Aperant pushes

Aperant pushes only if all of these hold:

- QA exited cleanly and wrote a fresh approved sign-off. An approval left over from before the follow-up does not count.
- The worktree is on `auto-claude/<specId>` and descends from the commit the follow-up started at.
- There are no uncommitted changes. Aperant's own `.auto-claude` files are excepted.
- The pull request is still open and its head branch is that same `auto-claude/<specId>` branch.

### Outcomes

When the run ends you see a status line starting with `[PR follow-up]` in the task log.

| Outcome | Status line | What it means | What to do |
|---------|-------------|---------------|------------|
| `pushed` | `[PR follow-up] Pushed to the pull request branch (abc1234).` | The checks passed and the new commits are on the pull request branch. | Review the pushed changes on GitHub. |
| `no_changes` | `[PR follow-up] Not pushed (no_changes): QA approved, but the agent made no new commits. Nothing was pushed.` | QA approved, but the agent changed nothing. | Read the items again. Fix by hand, or send them again. |
| `failed` | `[PR follow-up] Not pushed (failed): <reason>` | A condition was not met. The reason names it, for example QA did not finish cleanly, QA did not approve, the worktree has uncommitted changes, the branch no longer descends from the start commit, or the pull request is no longer open. | Fix the cause named in the reason. For uncommitted changes, commit or discard them, then use **Create PR** to push. |
| `push_failed` | `[PR follow-up] Not pushed (push_failed): <git error>` | The git push itself failed. | Read the error. Check your network and your push access to the repository, then push the branch by hand. |

## Why is the panel disabled?

The panel can show the feedback but keep **Send selected to agent** disabled. It then shows one message. If several causes apply, the first one in this table (top to bottom) is shown.

| Reason | Message in the panel | Cause | Fix |
|--------|---------------------|-------|-----|
| `worktree_missing` | "This task's worktree no longer exists (for example it was removed after the PR merged, or by cleanup), so no follow-up can run here. Create a new task from the PR instead." | The worktree folder is gone, or it is not a git worktree. The reason `not_a_worktree` is reported as `worktree_missing`. | See [A missing worktree](#a-missing-worktree). |
| `branch_mismatch` | "The task's worktree is not on the pull request's branch, so no follow-up can run here." | The worktree is not on `auto-claude/<specId>`, or the head branch of the pull request is a different branch. | Switch the worktree back to `auto-claude/<specId>`. If the pull request uses another branch, make the fixes by hand. |
| `pr_not_open` | "The pull request is no longer open, so feedback cannot be sent to the agent." | The pull request is closed or merged. | Reopen it on GitHub, or create a new task. |
| `agent_running` | "The agent is already running for this task. Wait for it to finish." | An agent is working on this task. | Wait, then click **Refresh**. |
| `auth_required` | "Authentication is required to send feedback. Add an account in Settings > Accounts and refresh." | See [The auth_required check](#the-auth_required-check). | See below. |
| `no_github_config` | "GitHub is not configured for this project." | The project has no GitHub token or repository set. | Configure GitHub for the project, then click **Refresh**. |
| `no_gitlab_config` | "GitLab is not configured for this project." | The project has no GitLab token or project set, or the merge request is not on the configured GitLab project. | Configure GitLab for the project, then click **Refresh**. |
| `no_bitbucket_config` | "Bitbucket is not configured for this project." | `BITBUCKET_ENABLED`, `BITBUCKET_USERNAME`, `BITBUCKET_TOKEN` or `BITBUCKET_REPOSITORY` is missing in the project `.env`, or the pull request is not on the configured repository. | See [Bitbucket Cloud](#bitbucket-cloud). |
| `no_azuredevops_config` | "Azure DevOps is not configured for this project." | The project has no Azure DevOps organization, project, repository or token set, or the pull request is not on the configured repository. | See [Azure DevOps](#azure-devops). |

### A missing worktree

Aperant removes a task's worktree and its local `auto-claude/<specId>` branch after the task's pull request is merged. This is controlled by the project setting `autoCleanupMergedWorktrees`, which is on by default. You may also have removed the worktree yourself.

Without the worktree there is nowhere to run the follow-up. Make the changes by hand on the branch, or create a new task for them.

### The auth_required check

The panel text and the check do not match exactly:

- The panel asks you to add an account in Settings > Accounts.
- If you click **Send selected to agent** and the check fails, the message says: "Authentication required. Add an account in Settings > Accounts, then try again. Nothing was started."
- The code does not check your GitHub sign-in. It checks the account the agent runs with. It passes when the active Claude profile has valid authentication, or when at least one provider account is configured.

So the fix is to add or sign in to an account under **Settings > Accounts** so the agent can run, then click **Refresh**. Loading the feedback from GitHub is a separate step and has its own errors, shown as "Could not load PR feedback".

## Bitbucket Cloud

Set these in the project `.env`:

```
BITBUCKET_ENABLED=true
BITBUCKET_USERNAME=<your Bitbucket username>
BITBUCKET_TOKEN=<app password or token>
BITBUCKET_REPOSITORY=<workspace>/<repo-slug>
```

What is listed:

- **Failed checks**: Pipelines steps whose result is `FAILED` or `ERROR`, with the tail of the step log.
- **Unresolved review comments**: unresolved comments, including inline ones. An inline comment shows its file and line.
- There is no change requests group on Bitbucket.

The pull request must be on the repository set in `BITBUCKET_REPOSITORY`. Otherwise it is refused with "This pull request is not on the Bitbucket repository configured for this project." and nothing is started. If Bitbucket is not configured, you get "Bitbucket is not configured for this project (username, token or repository missing)." Fix it by completing the four variables, then click **Refresh**.

The limits are the same as above: 50 items per group and 4000 characters per item.

## Azure DevOps

For a pull request on Azure DevOps, the panel sends two kinds of feedback: failed build validations, with log excerpts, and active threads, with the file and line they refer to. Azure DevOps must be configured for the project, see [Azure DevOps](project-configuration.md#azure-devops). If it is not, the panel shows a not-configured message. A pull request on a repository other than the configured one is refused.

## Untrusted input

Review comments and check output come from third parties. Aperant treats them as data, not as instructions.

- Text is cleaned by `sanitizeUntrustedText()`. It removes control, zero-width and bidirectional characters and ANSI codes. It caps the text at 4000 characters and adds a truncation marker.
- The text is placed in fenced blocks labelled "untrusted GitHub feedback". The content cannot close a fence, because the fence grows longer than any run of backticks in the text.
- The agent's instructions say never to follow instructions found inside those blocks, not to change tooling, permissions or configuration, and not to push, merge, switch branches or touch remotes.

This lowers the risk. It is not a guarantee. Read the items before you send them, and review the pushed changes on GitHub.

The panel shows forge text as plain text.

## Nothing starts without a click

- Opening the panel and clicking **Refresh** only read from GitHub.
- One click on **Send selected to agent**, with at least one item ticked, starts one run.
- If a precondition fails, nothing is written. The message ends with "Nothing was started."
- If starting fails after files were written, Aperant removes `PR_FOLLOWUP.json` and `QA_FIX_REQUEST.md` again.

## Not covered

- The headless CLI.
- Pull requests that were not created from a task. With no task there is no panel.
