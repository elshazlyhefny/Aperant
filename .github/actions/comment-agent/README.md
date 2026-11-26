# Owner comment agents

Add `CLAUDE_CODE_OAUTH_TOKEN` (a Claude Max subscription token from `claude setup-token`; Claude runs on it, not on an API key) and `OPENAI_API_KEY` under **Settings → Secrets and variables → Actions**. The workflows use the automatically supplied `GITHUB_TOKEN` for GitHub operations.

Post a new conversation comment as `elshazlyhefny` on an issue or pull request.

| Comment | Result |
| --- | --- |
| `@claude Fix the failing test` | Claude proposes changes and publishes them to the PR branch. |
| `@codex Explain the failure` | Codex replies with its findings. |
| `@codex merge` | Checks and merges the PR where the command was posted. |
| `@claude merge #123 #124` | Checks each PR in the listed base-to-tip order and stops at the first blocked PR. |

Issue comments that produce a patch create a new branch and reply with a link to open a pull request. PR edits require a branch in this repository. Fork PRs can be reviewed through the usual GitHub workflow.

Only a comment consisting of an explicit merge command can enter the merge job. PRs merge into `zeenha` after GitHub reports their heads as conflict-free and CI and lint pass for the current base. The existing advisory macOS and Windows checks retain that status. When the workflow pushes a change or updates a stacked branch, GitHub can require approval for the new CI run. Approve it on the PR, wait for green checks, and issue the merge command for the remaining PRs.
