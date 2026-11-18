# Opening a pull request from a task

**Create PR** pushes the task's branch and opens a pull request for it. Aperant picks the forge for you: Azure DevOps, Bitbucket Cloud, GitLab or GitHub. It writes the title and the description, adds the source-issue lines, and records the pull request on the task. This guide explains how that choice is made, what the pull request contains, and what to check when it goes somewhere you did not expect.

What happens after the pull request exists is covered in [PR Follow-ups](pr-follow-ups.md).

## Which forge is used

Aperant checks the forges in this order. The first row that matches wins.

| Order | Forge | Used when |
|-------|-------|-----------|
| 1 | Azure DevOps | Azure DevOps is configured for the project **and** `origin` matches the configured organization, project and repository. |
| 2 | Bitbucket Cloud | Bitbucket is configured for the project **and** `origin` is on `bitbucket.org`. |
| 3 | GitLab | GitLab is configured for the project **and** `origin` is on the host of the configured GitLab instance. |
| 4 | GitHub | None of the rows above matched. |

A forge that is configured but does not match `origin` is ignored. A project can keep GitLab configured for issues while its code lives on GitHub. The pull request then goes to GitHub.

How `origin` is matched:

| Forge | What is compared |
|-------|------------------|
| GitLab | The host of `origin` against the host of the configured instance URL. Case-insensitive. The port is ignored. The repository path is **not** compared. |
| Bitbucket Cloud | The host of `origin` against `bitbucket.org`, with the same rules as GitLab. The repository path is not compared. |
| Azure DevOps | Organization, project and repository, case-insensitive. |

Aperant reads `origin` (`git remote get-url origin` in the project folder) only when at least one of the three forges is configured. With none configured, it goes straight to GitHub.

### Examples

| Setup | Result |
|-------|--------|
| GitLab is configured for issues. `origin` is `git@github.com:me/app.git`. | The hosts differ, so GitLab is ignored. A GitHub pull request is opened. |
| Bitbucket and GitLab are both configured. `origin` is on `bitbucket.org`. | Bitbucket is checked before GitLab and matches. A Bitbucket pull request is opened. |
| GitLab is configured with `https://gitlab.example.com`. `origin` is `ssh://git@GitLab.Example.com:2222/team/other-repo.git`. | The hosts are equal (case and port are ignored). A GitLab merge request is opened. Aperant does not check that the repository is the configured one. |

## When it falls back to GitHub

GitHub is used when:

- No forge matched, as described above.
- A forge is configured but `origin` could not be read. This happens when `git` fails or takes longer than 10 seconds. All three forges are then dropped.

GitHub needs no project configuration. It does need the `gh` CLI installed and signed in. If `gh` fails, the task shows the error code `GH_FAILED` with the message `gh` printed. If `gh` times out (60 seconds), the code is `GH_TIMEOUT`. Network and server errors are tried up to three times. A timeout is not retried.

## Draft pull requests

When you ask for a draft:

| Forge | What you get |
|-------|--------------|
| GitHub | A real draft pull request. |
| Azure DevOps | A real draft pull request. |
| GitLab | A normal merge request whose title starts with `Draft: `. |
| Bitbucket Cloud | A normal pull request whose title starts with `Draft: `. Bitbucket has no native drafts. |

## What the pull request contains

### Title

1. A title you typed wins. It is checked for length and for printable characters, and refused if it fails.
2. Otherwise, Aperant asks the model for a Conventional Commits title (`type(scope): summary`, at most 72 characters, one clean line). It reads the committed branch to do this.
3. If that gives nothing usable, the task title is used, cut to its first sentence or lead clause, at most 100 characters.
4. As a last resort the title is `auto-claude: <specId>`.

### Description

- The model writes it from the commits, a summary of the diff, the repository's notes on running and testing, and the task's `qa_report.md`.
- If the model fails, the description is the first 500 characters of the spec (after its title).

### Source-issue lines

If the task came from an issue, Aperant adds a line for it. The code adds these lines, not the model. A line already in the description is not added again.

| Source | Line |
|--------|------|
| GitHub issue | `Fixes #N` |
| GitLab issue | `Closes #N` |
| Linear issue | `Fixes KEY` |
| Jira issue | `KEY` |

On Azure DevOps, `#123` links to a work item, so these lines never start with `#`. They read `Related GitHub issue: N`, `Related GitLab issue: N` or `Related issue: KEY`.

Azure DevOps also caps the description at 4000 characters. The issue lines are always kept. The rest is cut at a line break and ends with an ellipsis.

Subtask progress is not written into the title or the description. It is only used to choose the message when the branch has no commits, see below.

## Before the pull request is opened

Create PR does these steps in order and stops at the first one that fails:

1. It refuses any branch other than `auto-claude/<specId>` (error `BRANCH_REFUSED`).
2. It commits uncommitted work in the worktree. Aperant's own `.auto-claude` files are left out (error `COMMIT_FAILED` if the commit fails).
3. It stops if the branch has no commits beyond the base branch (error `NO_CHANGES`). If the plan still has unfinished subtasks, the message says: "This task stopped after N of M subtasks and has made no code changes yet…". Otherwise it says the task made no code changes.
4. It pushes with `--force-with-lease`, so a task branch that was rebased can be pushed again (error `PUSH_FAILED` on failure).

Only then are the title and description finished and the pull request created.

## When a pull request already exists

This is a success, not an error. Aperant looks up the open pull request for `auto-claude/<specId>` and records it as the task's pull request. The task moves to done and the link is saved. Each forge reports "already exists" in its own way, but the result is the same.

If the link cannot be read, the task status is left unchanged and you are told that the pull request already exists.

## After the pull request is opened

- The task status becomes `done` and the pull request link is saved on the task.
- The linked roadmap feature, if there is one, is marked completed.

### The `pr_opened` webhook

The webhook sends `pr_opened` only when a task moves into the `pr_created` status. Create PR from the app moves the task to `done`, and no other step in the app sets `pr_created`. So a pull request opened with Create PR does not send `pr_opened`. [Notifications and webhooks](notifications-and-webhooks.md#events) lists `pr_opened` for `pr_created` and does not say this. For the payload and the toggles, see that guide.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| The pull request went to GitHub and I expected another forge. | The forge is not configured, its host does not match `origin`, or `origin` could not be read. | Check the forge settings in [Project configuration](project-configuration.md). Run `git remote get-url origin` in the project folder and compare its host. |
| `gh` not found, or error `GH_FAILED`. | The GitHub path needs the `gh` CLI, installed and signed in. | Install `gh` and run `gh auth login`. Read the message in the error. |
| The Bitbucket or GitLab title starts with `Draft: `. | These forges get the draft as a title prefix. Bitbucket has no native drafts. | Remove the prefix on the forge when the pull request is ready. |
| The Azure DevOps description looks cut. | Azure DevOps allows 4000 characters. | Expected. The issue lines are kept. Edit the description on Azure DevOps if you need the rest. |
| "no code changes" message. | The branch has no commits beyond the base. | If the message says the task stopped after N of M subtasks, resume the task. If the work was done outside the code, mark the task as done. |

## Next steps

- [PR Follow-ups](pr-follow-ups.md): feedback on an open pull request is sent to the agent and pushed to the same branch.
- [Project configuration](project-configuration.md): the settings for each forge.
