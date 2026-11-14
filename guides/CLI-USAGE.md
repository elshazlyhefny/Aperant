# Aperant (formerly Auto Claude)

Aperant is the current name of the product formerly called Auto Claude. It is a desktop application. Most functionality is accessed through the Electron desktop UI. One task can also be run without the UI from a command line, for example in CI; see [Running a task headlessly](#running-a-task-headlessly).

## Getting Started

1. Install the app by following the [Install section of the README](../README.md#install)
2. Install and launch the application
3. Open your project (a git repository folder)
4. Connect Claude via the OAuth setup guide in the app
5. Create a task and let the agents work

## Running the App from Source

```bash
# Install dependencies
npm run install:all

# Development mode (hot reload)
npm run dev

# Production build + run
npm start
```

## Configuration

App-wide configuration is done through the app's Settings UI. Two per-project files, `.aperant.json` and `.auto-claude/.env`, also affect behaviour; see [project-configuration.md](project-configuration.md). In the Settings UI you can:

- Connect Claude accounts (OAuth or API key)
- Configure multiple provider profiles (Anthropic, OpenAI, Google, etc.)
- Turn the memory system on or off (the `memoryEnabled` setting; memory is stored locally in the app's data folder)
- Set default models and thinking budgets
- Configure Linear/GitHub/GitLab/Jira/Bitbucket integrations

## Running a task headlessly

The headless command runs one existing spec through the planner, coder and QA pipeline without opening the app, then leaves the work on a task branch for you to push or open as a pull request.

### Prerequisites

- Node 22 or newer.
- Dependencies installed with `npm run install:all`.
- A build: `npm run build` in `apps/desktop`. This produces `apps/desktop/out/main/cli.js`.
- The project is a git repository.
- A spec at `.auto-claude/specs/<id>/` with a `spec.md`. `.auto-claude/` is gitignored in this repository, so a CI job must create or restore the spec before it runs the command.

### Command

```bash
node apps/desktop/out/main/cli.js run <spec> [--project <dir>] [--config <file>] \
  [--base-branch <b>] [--no-push] [--json] [--verbose]

# or, from apps/desktop
npm run cli -- run <spec> ...
```

`<spec>` is the spec id (the folder name under `.auto-claude/specs/`).

| Flag | Purpose |
|------|---------|
| `--project <dir>` | Project directory. Default: the current directory. |
| `--config <file>` | JSON config file (see [Credentials](#credentials)). |
| `--base-branch <b>` | Branch the task worktree is created from. Overrides `.aperant.json` and the config file. Default: `main`. |
| `--no-push` | Do not push the task branch. |
| `--json` | Print one JSON event per line on stdout. |
| `--verbose` | Print detailed progress in text mode. |
| `--help`, `-h` | Show usage. |
| `--version`, `-v` | Print the version. |

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success. QA passed. |
| 1 | Error: bad arguments, setup failure, planning or coding failure, the run was interrupted, or the token budget was reached (see [Token budget](#token-budget)). |
| 2 | QA failed after the maximum number of iterations. |

### Output

- Text mode prints phase lines such as `[coding] subtask: message` on stdout. `--verbose` adds detailed log lines.
- `--json` prints one JSON object per line on stdout: `{"type":"progress",...}`, `{"type":"log",...}`, `{"type":"task-event",...}` and a final `{"type":"result","kind":...,"exitCode":...}`.
- The last line in text mode is `RESULT <kind> exit=<code> spec=<id> branch=<branch> worktree=<path>`, where `kind` is `success`, `qa_failed` or `error`.
- Errors and the failure reason go to stderr (`error: ...`, `reason: ...`). Output has ANSI codes stripped and known secret values replaced with `[REDACTED]`.

### Credentials

The command never reads the desktop app's settings. Credentials come from the environment or an explicit config file.

- Environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `ZHIPU_API_KEY`, `AZURE_OPENAI_API_KEY`.
- `CLAUDE_CODE_OAUTH_TOKEN`, created with `claude setup-token`, is used for Anthropic when no `ANTHROPIC_API_KEY` is set. It needs the `claude` CLI on `PATH`.
- Optional `--config <file>`, a JSON object. All keys are optional:

```json
{
  "providerAccounts": [],
  "globalPriorityOrder": ["account-id"],
  "providerAgentConfig": {},
  "webhook": {
    "url": "https://hooks.example.com/services/XXX",
    "events": { "reviewReady": true, "failed": true, "blocked": true, "prOpened": false }
  },
  "project": {
    "mainBranch": "main",
    "pushNewBranches": true,
    "envPassthrough": [],
    "bashSandbox": "off"
  }
}
```

`providerAccounts` uses the same account objects as the app. `globalPriorityOrder` lists account ids in the order to try them. When both are set, the account queue is tried first, then the environment. `project` overrides the main branch, whether to push, extra environment variable names passed to Bash, and the sandbox mode. A config file that is missing or invalid stops the run with exit code 1.

`webhook` sends a Slack-compatible message when the run ends: `review_ready` on exit 0, `blocked` on exit 2, `failed` on exit 1. The `APERANT_WEBHOOK_URL` environment variable overrides `webhook.url`. A webhook problem never changes the exit code. See [notifications-and-webhooks.md](notifications-and-webhooks.md#headless-runs-clijs-run).

### Token budget

The budget comes only from the spec's `task_metadata.json`, key `tokenBudget`, at `.auto-claude/specs/<id>/task_metadata.json` in the project directory (`--project`). There is no project default: the CLI never reads the app's project settings, and the `--config` file has no budget key.

```json
{ "tokenBudget": 500000 }
```

`.auto-claude/` is gitignored, like `spec.md`, so a CI job must write this file itself.

- A positive whole number is the limit. `0` means unlimited.
- A missing key, a missing file or an invalid value means unlimited, even if the desktop project has a limit.
- Counting is the same as in the app: input plus output tokens, with cache tokens not added again, cumulative over the task.

When the limit is reached the run stops with exit code 1 (not 0, not 2). It prints `reason: token budget reached: <used> of <limit> tokens used` on stderr and a final `RESULT error exit=1 ...` line. It is never reported as success.

To continue, raise `tokenBudget` (or set it to `0`) in `task_metadata.json` and run the same spec again. The run reuses the existing worktree for that spec.

See [token-budgets.md](token-budgets.md) for the app side.

### Behaviour

These match the app:

- The task runs in the worktree `.auto-claude/worktrees/tasks/<id>` on branch `auto-claude/<id>`. If the worktree cannot be created the task does not start; there is no fallback to the project root.
- Landing is pull-request only, and this cannot be turned off. There is no merge command. The CI job pushes and opens the PR itself, for example with `gh pr create`.
- The Bash validator, path containment and credential scrubbing run in the same worker as in the app.
- Project MCP servers stay unapproved, so a cloned repository cannot start processes in CI. See [Approving project MCP servers](project-configuration.md#approving-project-mcp-servers).

Differences from the app:

- Memory is off (no memory service).
- No desktop notifications.
- The task's status is not shown in the Kanban board.

### GitHub Actions example

This workflow starts when an issue gets the `aperant` label. It assumes the job has written the spec to `.auto-claude/specs/issue-<number>/spec.md`.

```yaml
name: aperant-task
on:
  issues:
    types: [labeled]

permissions:
  contents: write
  pull-requests: write

jobs:
  run:
    if: github.event.label.name == 'aperant'
    runs-on: ubuntu-latest
    env:
      SPEC: issue-${{ github.event.issue.number }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm run install:all
      - run: npm run build
        working-directory: apps/desktop
      - name: Write the spec
        env:
          ISSUE_TITLE: ${{ github.event.issue.title }}
          ISSUE_BODY: ${{ github.event.issue.body }}
        run: |
          mkdir -p ".auto-claude/specs/$SPEC"
          printf '# %s\n\n%s\n' "$ISSUE_TITLE" "$ISSUE_BODY" > ".auto-claude/specs/$SPEC/spec.md"
      - name: Run the task
        id: task
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          set +e
          node apps/desktop/out/main/cli.js run "$SPEC" --base-branch main
          echo "code=$?" >> "$GITHUB_OUTPUT"
      - name: Open the pull request
        if: steps.task.outputs.code == '0'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh pr create --head "auto-claude/$SPEC" --base main \
            --title "Aperant: ${{ github.event.issue.title }}" \
            --body "Closes #${{ github.event.issue.number }}"
```

The issue text is passed through `env` and not interpolated into the shell script, so it cannot inject commands.

### Troubleshooting

Exit code 1:

- `No credentials found. Set one of: ...`: set one of the variables listed above, or pass `--config` with `providerAccounts`.
- `Could not create the task's git worktree, so the task was not started ...`: check that the directory is a git repository with a commit, that the base branch exists (use `fetch-depth: 0` in CI), and that no stale worktree or branch for the spec exists.
- `Spec not found: .../spec.md does not exist`: create `.auto-claude/specs/<id>/spec.md` first.
- `... is not inside a git repository`: pass `--project` or run from the repository.
- `Cannot read config file ...`: the `--config` file is missing or not valid JSON.

Any exit code:

- `warning: webhook ...` on stderr: the webhook URL was rejected or delivery failed. The exit code is not affected. Check the URL rules in [notifications-and-webhooks.md](notifications-and-webhooks.md#url-rules).

Exit code 2: QA did not pass. Read `qa_report.md` in the worktree's spec directory, `.auto-claude/worktrees/tasks/<id>/.auto-claude/specs/<id>/qa_report.md`, for the remaining issues.
