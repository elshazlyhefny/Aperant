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

The headless command runs one existing spec through the planner, coder and QA pipeline without opening the app, then leaves the work on a task branch for you to push or open as a pull request. A spec no longer has to be written by hand: the `new` command creates one from a one-line description (see [Creating a spec from a description](#creating-a-spec-from-a-description)).

### Prerequisites

- The project is a git repository.
- A spec at `.auto-claude/specs/<id>/spec.md`, or create one with `new`. `.auto-claude/` is gitignored in this repository, so a CI job must create or restore the spec before it runs `run`.

#### Building from source

Use Node 24 or newer and npm 10 or newer. Run `npm ci --ignore-scripts` at the checkout root, then run `npm run build` in `apps/desktop`. This produces `apps/desktop/out/main/cli.js`. The CLI does not need Electron's install scripts.

#### Running a built CLI

Use Node 24 or newer. Node 22 is not verified for runtime use.

Keep `apps/desktop/out/` in the checkout. The bundle loads dependencies from the installed `node_modules` and prompts from `apps/desktop/prompts`.

The [`cli-build` and `cli-runtime` jobs](../.github/workflows/ci.yml) check the source build and smoke-test that same build. The runtime smoke is required on Node 24 and informational on Node 22.

### Creating a spec from a description

```bash
node apps/desktop/out/main/cli.js new "<description>" [--project <dir>] [--config <file>] \
  [--run | --queue] [--base-branch <b>] [--no-push] [--json] [--verbose]

# or, from apps/desktop
npm run cli -- new "<description>" ...
```

`--run` and `--queue` are mutually exclusive: passing both exits 1. `--queue` creates the spec and then puts the task in the Queue for a running `serve` daemon (see [Listing and queueing tasks](#listing-and-queueing-tasks)) instead of building it in this process. It exits 0 (spec created and queued) or 1 (error).

`new` runs the same spec pipeline as the app: complexity assessment, then discovery, requirements, spec writing, planning and validation as needed. It writes `spec.md`, `implementation_plan.json` and the other plan files to `.auto-claude/specs/<NNN-slug>/`.

- The number `NNN` is the next free one. The command takes a lock while it picks it, and it also counts specs in task worktrees.
- In text mode it prints `RESULT success exit=0 spec=<id>`. With `--json` the same `progress` and `log` events as `run --json` are printed, followed by a final `{"type":"result",...,"spec":"<id>"}`.
- Credentials, `--config` and exit codes work as for `run`. Without `--run`, the exit codes are 0 (spec created) and 1 (error).
- On failure the command exits 1 and removes the half-written spec folder, so nothing is left under `.auto-claude/specs`.
- Spec creation has no token budget. The budget applies only to the build (see [Token budget](#token-budget)).
- With `--run` the command continues into the build in the same process and returns the exit codes of `run` (0, 1 or 2). A single `RESULT` line is printed at the end. `--base-branch` and `--no-push` apply to the build.

Then run the spec with `run <id>`, or pass `--run` to do both in one step.

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
| `--run` | `new` only: continue into the build in the same process. Returns the exit codes of `run` (0, 1, 2). |
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
- `--json` prints one JSON object per line on stdout: `{"type":"progress",...}`, `{"type":"log",...}`, `{"type":"task-event",...}`, `{"type":"token-budget",...}` and a final `{"type":"result","kind":...,"exitCode":...}`.
- The last line in text mode is `RESULT <kind> exit=<code> spec=<id> branch=<branch> worktree=<path>`, where `kind` is `success`, `qa_failed` or `error`.
- Errors and the failure reason go to stderr (`error: ...`, `reason: ...`). Output has ANSI codes stripped and known secret values replaced with `[REDACTED]`.

### Delivery receipts

Outcome notifications and issue updates are reported separately from the build. Standalone `run` prints `DELIVERY` lines (or one `delivery-receipts` event in `--json` mode) when there are receipts, before the final build result. In `serve --json`, the daemon reports receipts separately after saving the task status; use `taskId` to correlate them with build events. Delivery does not change task status, the final `result` event, or the build exit code.

Read saved history without running the task again, even after an interrupted run:

```bash
node apps/desktop/out/main/cli.js receipts 001-demo --project ./my-project --json
# or, from apps/desktop
npm run cli -- receipts 001-demo --project ../../my-project --json
```

`--project` defaults to the current directory. Omit `--json` for text. JSON mode prints one line, for example:

```json
{"type":"delivery-receipts","spec":"001-demo","receipts":[{"id":"9bbb4452-2b19-4a58-ac44-82d44c44ca9e","operation":"webhook","provider":"slack","event":"review_ready","createdAt":"2026-11-27T12:00:00.000Z","status":"unknown","reason":"unconfirmed"}]}
```

`receipts` is read-only: it does not load delivery credentials, start a worker, or send or replay anything. It exits `0` on a successful read (including empty history) and `1` if the project, task, or history cannot be read. See [how to interpret delivery history](notifications-and-webhooks.md#delivery-history).

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
    "format": "auto",
    "secret": "a-long-random-string",
    "events": { "reviewReady": true, "failed": true, "blocked": true, "prOpened": false }
  },
  "project": {
    "mainBranch": "main",
    "pushNewBranches": true,
    "envPassthrough": [],
    "bashSandbox": "off",
    "defaultTokenBudget": 1000000
  },
  "memory": { "enabled": true }
}
```

`memory.enabled` turns agent memory on or off (default on; see [Behaviour](#behaviour)). `providerAccounts` uses the same account objects as the app. `globalPriorityOrder` lists account ids in the order to try them. When both are set, the account queue is tried first, then the environment. `project` overrides the main branch, whether to push, extra environment variable names passed to Bash, and the sandbox mode. `project.defaultTokenBudget` sets an optional [token budget](#token-budget) for builds without a task value. A config file that is missing or invalid stops the run with exit code 1.

`webhook` sends a message in Slack, Microsoft Teams or Discord format when the run ends (`format` is `auto`, `slack`, `teams` or `discord`; `auto` is the default and detects it from the URL): `review_ready` on exit 0, `blocked` on exit 2, `failed` on exit 1, except `account_required` (gated by the `blocked` toggle) when the run paused because no account is usable for a phase's provider. The `APERANT_WEBHOOK_URL` environment variable overrides `webhook.url`, and `APERANT_WEBHOOK_SECRET` overrides `webhook.secret`. With a secret, requests are signed, whatever the format (see [Signing requests](notifications-and-webhooks.md#signing-requests-optional-secret)). A webhook problem never changes the exit code. See [notifications-and-webhooks.md](notifications-and-webhooks.md#headless-runs-clijs-run).

`writeback` reports the outcome back to the issue tracker the task was imported from. It is off by default, applies to both `run` and `serve`, and never changes the exit code. A run that paused because no account is usable for a phase's provider produces no write-back (the webhook still sends `account_required`). Credentials come from the project's `.auto-claude/.env`. Example:

```json
{
  "writeback": {
    "github": true,
    "gitlab": false,
    "linear": false,
    "jira": { "enabled": false, "comment": true, "transitionOnReview": false, "transitionStatusName": "In Review" },
    "azureBoards": { "enabled": false, "transitionOnReview": false, "transitionStateName": "Resolved" }
  }
}
```

Setting `linear` to `true` enables comments only; moving a Linear issue to another workflow state is desktop-only.

See [notifications-and-webhooks.md](notifications-and-webhooks.md#reporting-back-to-the-issue-tracker-write-back) for the credentials, CI fallbacks and rules.

### Token budget

The CLI looks for `tokenBudget` in the spec's `.auto-claude/specs/<id>/task_metadata.json` in the project directory (`--project`). If the task has no value, the CLI uses `project.defaultTokenBudget` from the `--config` file, if set. Otherwise the build is unlimited. The CLI never reads the desktop app's project or user settings.

If set, `project.defaultTokenBudget` must be a positive whole number. Any other value, including `0`, stops the run with exit code 1 before a worker starts. Omit the key for no default.

| Situation | Effective budget |
|-----------|------------------|
| Task value is positive | The task value (rounded down; unlimited if it rounds down to `0`). |
| Task value is `0` | Unlimited, even when a headless default is set. |
| Task value is invalid or negative | Unlimited, even when a headless default is set. |
| Task key or file is missing, or the key is `null` | The headless default if set, otherwise unlimited. |
| Task was created by a schedule | The schedule's per-run budget, regardless of the headless default. |

Example task override:

```json
{ "tokenBudget": 500000 }
```

`.auto-claude/` is gitignored, like `spec.md`. To set a task override in CI, write or restore this file in the job.

The CLI reports the effective budget before starting the build:

- Text: `token budget: 1000000 tokens (source: config)` or, for example, `token budget: unlimited (source: task)`.
- JSON: `{"type":"token-budget","limit":1000000,"source":"config"}`. The limit is `null` for unlimited. The final `result` event for the build includes a `tokenBudget` object with the same `limit` and `source`. Setup failures can omit this field.

The source is `task` for a task override (including `0` or an invalid value), `schedule` for a schedule's per-run budget, `config` for the headless default, or `none` when no value is set.

Usage is cumulative across the task: input plus output tokens, with cache tokens not added again. The budget is not a hard real-time cap. Each planning, coding and QA session re-reads the usage recorded in `run_metrics.json` at the start of the session. A running session checks its own usage between model requests and steps. A schedule's per-run budget is also checked between sessions. A run can end above the limit.

When the limit is reached the run stops with exit code 1 (not 0, not 2). It prints `reason: token budget reached: <used> of <limit> tokens used` on stderr and a final `RESULT error exit=1 ...` line. It is never reported as success.

Usage carries over on resume. If the task reached the headless default, rerunning without a task override while that default is still in effect pauses it again immediately. To continue, set `tokenBudget` in `task_metadata.json` to a value higher than the recorded usage, or to `0` for unlimited. Run the same spec again to reuse its worktree.

See [token-budgets.md](token-budgets.md) for the app side.

### Behaviour

These match the app:

- The task runs in the worktree `.auto-claude/worktrees/tasks/<id>` on branch `auto-claude/<id>`. If the worktree cannot be created the task does not start; there is no fallback to the project root.
- Landing is pull-request only, and this cannot be turned off. There is no merge command. The CI job pushes and opens the PR itself, for example with `gh pr create`.
- The Bash validator, path containment and credential scrubbing run in the same worker as in the app.
- Project MCP servers stay unapproved, so a cloned repository cannot start processes in CI. See [Approving project MCP servers](project-configuration.md#approving-project-mcp-servers).

Differences from the app:

- Memory is on, as in the app, but it lives in a separate file per project, `.auto-claude/memory.db` in the main checkout, not in the app's data folder. Memories recorded by the CLI are not shown in the app, and the CLI does not see the app's memories. Embeddings use a local Ollama model when one is running and an offline fallback otherwise; the app's hosted embedding settings are not read. Set `"memory": { "enabled": false }` in the `--config` file to turn memory off.
- No desktop notifications.
- The task's status is not shown in the Kanban board.

### GitHub Actions example

This workflow starts when an issue gets the `aperant` label. It assumes the job has written the spec to `.auto-claude/specs/issue-<number>/spec.md`. The `cli-build` job runs the same install and build steps on every change.

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
          node-version: 24
      - name: Install dependencies
        run: npm ci --ignore-scripts
      - name: Build application
        working-directory: apps/desktop
        run: npm run build
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

To let Aperant write the spec from the issue text instead, replace the "Write the spec" and "Run the task" steps with one step. `new` prints the spec id, so give the job `SPEC` from the `RESULT` line, or list the new folder under `.auto-claude/specs/`:

```yaml
      - name: Create the spec and run the task
        id: task
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ISSUE_TITLE: ${{ github.event.issue.title }}
          ISSUE_BODY: ${{ github.event.issue.body }}
        run: |
          set +e
          node apps/desktop/out/main/cli.js new "$ISSUE_TITLE: $ISSUE_BODY" --run --base-branch main
          echo "code=$?" >> "$GITHUB_OUTPUT"
```

The issue text is again passed through `env`. The later steps need the spec id for the branch name `auto-claude/<id>`.

### Troubleshooting

- Start with [`check`](#checking-readiness-before-a-run) using the same spec, project, config and base branch. Fix any blocking setup problems before retrying `run`.

Exit code 1:

- `No credentials found. Set one of: ...`: set one of the variables listed above, or pass `--config` with `providerAccounts`.
- `Could not create the task's git worktree, so the task was not started ...`: check that the directory is a git repository with a commit, that the base branch exists (use `fetch-depth: 0` in CI), and that no stale worktree or branch for the spec exists.
- `Spec not found: .../spec.md does not exist`: create `.auto-claude/specs/<id>/spec.md` first.
- `... is not inside a git repository`: pass `--project` or run from the repository.
- `Cannot read config file ...`: the `--config` file is missing or not valid JSON.
- `Missing <description> argument`: pass the description after `new`, in quotes.
- Spec creation failed (`new` exited 1): the half-written spec folder was removed. Run the command again, or write the spec by hand.

Any exit code:

- `warning: webhook ...` on stderr: the webhook URL was rejected or delivery failed. The exit code is not affected. Check the URL rules in [notifications-and-webhooks.md](notifications-and-webhooks.md#url-rules).

Exit code 2: QA did not pass. Read `qa_report.md` in the worktree's spec directory, `.auto-claude/worktrees/tasks/<id>/.auto-claude/specs/<id>/qa_report.md`, for the remaining issues.

## Checking readiness before a run

Use `check` to catch locally verifiable setup problems before starting `run` or `serve`. It uses the same CLI build as `run`.

```bash
node apps/desktop/out/main/cli.js check [<spec>] [--project <dir>] [--config <file>] \
  [--base-branch <b>] [--daemon] [--json]

# or, from apps/desktop
npm run cli -- check ...
```

| Flag | Purpose |
|------|---------|
| `--project <dir>` | Project directory. Default: the current directory. |
| `--config <file>` | Same JSON config file as for `run` (see [Credentials](#credentials)). |
| `--base-branch <b>` | Override the base branch. Otherwise use `.aperant.json`, then `project.mainBranch` in the config, then `main`. |
| `--daemon` | Check for a conflicting queue owner and use `serve`'s stricter webhook configuration rules. |
| `--json` | Print one JSON report on stdout instead of a text report. |

By default, `check` looks for a Git repository with a commit and a locally available base ref (remote-tracking `origin/<base>` or local `<base>`). It does not fetch. It also checks the config file and recognized settings, webhook configuration, availability of tools for the selected Bash sandbox mode, and local credentials for a default run.

Pass a spec id or a path to a spec directory inside the selected checkout's `.auto-claude/specs/` to check that `spec.md` exists, inspect metadata, report the [effective token budget](#token-budget), and check local credential configuration for the planning, coding and QA phases instead of the default run.

### Stable check codes

| Code | Meaning |
|------|---------|
| `git.repository` | The selected directory is inside a Git working tree. |
| `git.commit` | `HEAD` resolves to a commit. |
| `git.base_ref` | A local or locally tracked remote ref exists for the resolved base branch. |
| `config.file` | The explicit config file loads and passes schema checks, or defaults are used. |
| `config.values` | Project settings such as `bashSandbox` and `webFetchProvider` are recognized. |
| `config.webhook` | The webhook is checked locally, without sending anything. Invalid URLs warn for `run` and can block `serve`. |
| `sandbox.tools` | The configured Bash sandbox mode is off or supported with its required tool available. |
| `queue.owner` | In daemon mode, checks whether another process holds the project queue lock. |
| `spec.found` | The requested spec has a `spec.md` file. |
| `spec.metadata` | `task_metadata.json` is readable and parses as JSON, or defaults are used. |
| `budget.effective` | The effective token limit, or unlimited (`details.tokenBudget` is `null`). |
| `credentials.default` | Local credential configuration for a default run when no spec is supplied. |
| `credentials.planning` | Local credential configuration for the spec's planning phase. |
| `credentials.coding` | Local credential configuration for the spec's coding phase. |
| `credentials.qa` | Local credential configuration for the spec's QA phase. |
| `credentials.remote` | Token validity, scopes and quotas are not tested. |

### Statuses and exit codes

| Status | Meaning |
|--------|---------|
| `valid` | The local check passed. For credentials, this can mean a key is configured, not that the provider accepts it. |
| `unavailable` | A required local prerequisite is missing, invalid or unsupported. |
| `unverified` | The check did not verify the prerequisite, for example when an OAuth profile is configured but the keychain has not been read. |
| `warning` | A non-blocking issue, such as an unrecognized setting with a fallback. |
| `not_applicable` | The check does not apply or was skipped because a prerequisite failed. |

Token validity, scopes and quotas are never tested because verifying them requires a provider request. `check` is read-only: it starts no worker, refreshes no credentials, reads neither the OS keychain nor token-file contents, makes no network requests, and writes no files or locks. Known secrets and webhook URLs are redacted in text and JSON output.

Exit code **0** means ready: there were no blocking problems, though warnings or unverified items may remain. Exit code **1** means a blocking problem (`status: "unavailable"` and `blocking: true`) or a CLI usage error.

### JSON output

For a completed check, `--json` prints one report with this shape (example `checks` array abbreviated):

```json
{
  "version": 1,
  "ok": true,
  "mode": "run",
  "project": "/path/to/project",
  "spec": "001-my-spec",
  "checks": [
    {
      "code": "budget.effective",
      "status": "valid",
      "blocking": false,
      "message": "500000 tokens",
      "details": { "tokenBudget": 500000, "source": "task_metadata.json" }
    }
  ]
}
```

`mode` is `run` or `daemon`. `project` is the resolved Git root or `null`, and `spec` is the reported spec id or `null`. Each check has a stable `code`, `status`, `blocking` and `message`, and may include `guidance` or a `details` object. Use `ok`, `code` and `status` for automation rather than matching the message text.

### Using the check in GitHub Actions

After building the CLI and preparing `.auto-claude/specs/001-my-spec/spec.md` and `ci.json`, put the readiness check before the run step. Give both steps the same credential environment and setup options. A blocking check fails the step, so GitHub Actions skips the run step by default.

```yaml
      - name: Check readiness
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: node apps/desktop/out/main/cli.js check 001-my-spec --config ci.json --json
      - name: Run the task
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: node apps/desktop/out/main/cli.js run 001-my-spec --config ci.json
```

## Listing and queueing tasks

```bash
node apps/desktop/out/main/cli.js list [--project <dir>] [--json]
node apps/desktop/out/main/cli.js queue <spec> [--project <dir>] [--json]

# or, from apps/desktop
npm run cli -- list ...
npm run cli -- queue <spec> ...
```

- `list` prints the project's tasks sorted by spec id, one per line: id, status and title. With `--json` it prints a single JSON array of `{"specId","status","title"}` objects.
- `queue <spec>` moves the task to the Queue so a running [`serve` daemon](#running-the-queue-and-schedules-as-a-daemon) picks it up. It only accepts tasks in `backlog`; a task in any other status is refused. It prints `Queued <spec>`, or with `--json` `{"specId":"<spec>","status":"queue"}`.
- `new "<description>" --queue` does the same for a newly created spec, as an alternative to `--run`.
- Exit codes: 0 (ok) and 1 (error, such as an unknown spec or a task that is not in the backlog).

## Stopping one task

```bash
node apps/desktop/out/main/cli.js stop <spec> [--requeue] [--project <dir>] [--json]

# or, from apps/desktop
npm run cli -- stop <spec> ...
```

`stop <spec>` asks the [`serve` daemon](#running-the-queue-and-schedules-as-a-daemon) of the same project to stop one running task.

- **Transport.** The request is a file in `.auto-claude/.locks`. There is no network port. The daemon picks it up on its 30 second safety interval, so the task can take up to about 30 seconds to stop.
- **Default.** The task ends as `human_review` with the reason `stopped`, and its stuck subtasks are reset. Resume it later from the app or the command line.
- **`--requeue`.** The task goes back to the Queue instead, and the daemon starts it again when a slot is free.
- **Everything else continues.** Other running tasks and the schedules are not affected.
- Exit codes: 0 (request sent) and 1 (error, including when no daemon holds the project's lock).

From the desktop app, use **Stop on daemon**; see [Using the desktop app while serve runs](#using-the-desktop-app-while-serve-runs).

## Running the queue and schedules as a daemon

`serve` runs one project's task queue and its recurring schedules without opening the app, until you stop it. Use it on a server or a machine where the app is not open. It needs a git repository, the same [built CLI and Node runtime](#running-a-built-cli) as `run`, and the same [credentials](#credentials).

### Command

```bash
node apps/desktop/out/main/cli.js serve [--project <dir>] [--config <file>] \
  [--schedules <file>] [--project-id <id>] [--base-branch <b>] [--no-push] \
  [--shutdown-timeout <sec>] [--json] [--verbose]

# or, from apps/desktop
npm run cli -- serve ...
```

| Flag | Purpose |
|------|---------|
| `--project <dir>` | Project directory. Default: the current directory. |
| `--config <file>` | JSON config file, the same file as for `run`, plus the keys below. |
| `--schedules <file>` | Schedules file. Default: `<project>/.auto-claude/schedules.json`. |
| `--project-id <id>` | Use the schedules of this desktop project id. See [The schedules file](#the-schedules-file). |
| `--base-branch <b>` | Branch the task worktrees are created from. |
| `--no-push` | Do not push task branches. |
| `--shutdown-timeout <sec>` | Seconds to wait for running tasks after SIGTERM or SIGINT. Default: 30. |
| `--json` | Print one JSON event per line. |
| `--verbose` | Print detailed progress. |

### What it runs

- **The queue.** Tasks in the Queue start in dependency order, as in the app, while the number of running tasks is under the project's parallel limit. The limit is `project.maxParallelTasks` in the config file (default 3). The desktop project setting is not read.
- **Tasks queued from the command line.** `queue <spec>` and `new --queue` only change the task's status to Queue. They do not talk to the daemon (no IPC). A running daemon picks the change up on its next safety pass, about 30 seconds later (`SAFETY_PROCESS_INTERVAL_MS` in `serve.ts`).
- **Schedules.** Due schedules follow the same rules as in the app. A run counts as missed when it is more than 5 minutes late or several runs are due at once. With `"missedRunPolicy": "catch_up"` in `schedules.json` (the default when the field is omitted), the daemon records one `missed` entry and creates one catch-up task. With `"missedRunPolicy": "skip"`, the daemon records `skipped_missed`, creates no task, and waits for the next scheduled run. An unfinished previous task takes precedence over either policy. The daemon logs each schedule's policy at startup and writes a log line for each new history entry. See [recurring-tasks.md](recurring-tasks.md#missed-runs).
- **Outcomes.** When a task finishes, its status is saved in the project (Human Review for a pass or a QA rejection, Error otherwise) and the [outcome webhook](notifications-and-webhooks.md) is sent if the config file enables it. The Kanban board shows the result when you open the app later.
- **Token budgets.** Queued tasks without a value in `task_metadata.json` inherit `project.defaultTokenBudget` if set, as for [`run`](#token-budget). Schedule budgets are unchanged: the per-run budget overrides the headless default. When a scheduled task stops at its limit, it is set to Error and the schedule records `budget_exceeded`.

### The lock

The daemon takes a lock on the project's queue. The desktop app takes the same lock when it runs the queue. The app and the daemon therefore cannot run the same project at once. If another process holds the lock, `serve` prints

```
Cannot start: project queue is already run by <holder>
```

and exits with code 3. Stop the other process (close the app, or stop the other daemon) and start `serve` again.

Use [`check --daemon`](#checking-readiness-before-a-run) to report a conflicting queue owner in advance (the condition that causes `serve` to exit 3), without taking the lock.

### Using the desktop app while serve runs

- **The banner.** When another process holds a project's queue lock, that project's Kanban board shows "Queue is run by `<holder>`". The holder looks like `daemon (pid 1234 on host build-01, since 2026-11-27T10:00:00.000Z)` or `desktop app (...)` if another app instance holds the lock. The second line reads "The desktop queue and schedules are paused for it until it stops." The app takes the lock at startup. If the app holds it first, `serve` exits with code 3 (see [The lock](#the-lock)). The daemon banner appears when `serve` took the lock first and still holds it.
- **What is paused in the app.** The app does not start queued tasks for this project. The daemon starts them instead, including tasks you queue from the app or with `queue <spec>`. The app's schedules do not create tasks, and **Run now** is refused. A due run stays due until the lock is released. The next schedule check applies the usual rules, including creating one catch-up task for [missed runs](recurring-tasks.md#missed-runs). The daemon runs schedules from [its own schedules file](#the-schedules-file), not the app's. Other projects are unaffected.
- **Opening a daemon-run task.** When the daemon holds the lock, the banner shows "Running in the daemon:" if any tasks in `.auto-claude/.locks/serve-running.json` are still **In Progress** on the board. Each listed task has a button. Click its name to open the task's detail dialog. Tasks that have left **In Progress** are not listed.
- **Stop on daemon.** This replaces **Stop** on the task card and in the detail dialog footer, but only for tasks that are **In Progress** and listed by the daemon. Desktop-run tasks keep the normal **Stop**. The button writes the same request file as [`cli.js stop <spec>`](#stopping-one-task). There is no network port.
- **Why it stays pending.** The button is disabled and reads "Stopping on daemon..." with the tooltip "Waiting for the daemon to stop this task". The daemon reads requests on its 30-second safety interval, so it can take about 30 seconds to pick up the request. The app checks every 2 seconds, for up to 3 minutes. It treats the task leaving **In Progress** as confirmation.
- **What it stops.** Only the selected task. It moves to **Human Review** with the reason `stopped` and its stuck subtasks reset. It is not requeued. The daemon keeps running, and other running tasks and schedules continue. To stop the whole daemon with SIGTERM or SIGINT, see [Stopping](#stopping). To put the task back in the **Queue** instead, use [`cli.js stop <spec> --requeue`](#stopping-one-task). The app has no requeue option.

**Troubleshooting**

**No Stop on daemon button.** Check that the task is **In Progress** and the banner names a daemon. If another desktop instance holds the lock, use **Stop** in that instance. The daemon may not have listed the task in `serve-running.json` yet. If the board's queue state is stale, switch to another project and back, or reopen the app to reload it.

**"No daemon is running, so the task cannot be stopped from here."** No live daemon holds this project's lock. Check whether `serve` is still running for this project and reload the board.

**"This task is not running on the daemon."** The daemon's `serve-running.json` does not list the task. Check its current status and reload the board before retrying.

**"The daemon released the task without stopping it. Check its status."** The app could no longer find a live daemon holding the lock while the task was still **In Progress**. The app tries to delete the leftover request so a later daemon does not apply it. Check the task's status. On restart, the daemon recovers tasks it left running by putting them back in the **Queue** (see [Stopping](#stopping)).

**"The daemon did not stop the task in time. Try again."** The app did not see the task leave **In Progress** within 3 minutes. Check that the daemon is still running and review its output (`--verbose` or `--json` if enabled). Then retry or use [`cli.js stop <spec>`](#stopping-one-task).

_Keep this section in sync with `DaemonQueueBanner.tsx`, `useDaemonStop.ts`, `daemon-stop.ts` and `ipc-handlers/daemon-stop-handlers.ts`._

### The schedules file

By default the daemon reads and writes `<project>/.auto-claude/schedules.json`, in the same format as the app's `schedules.json` in its user data folder. To use the schedules you made in the desktop app, copy that file into the project, or pass it with `--schedules`, and add `--project-id <id>` with the desktop project's id. With `--project-id` only the schedules of that project are used, and they run against the project given by `--project`. The daemon writes the run history back to the file you point it at. Without `--project-id` every schedule in the file runs against `--project`.

If the file is missing or corrupt, the daemon has no schedules and only runs the queue.

### Config file keys

`serve` uses the same config file as `run` (see [Credentials](#credentials)). This example sets a webhook, a parallel task limit and a default token budget:

```json
{
  "webhook": {
    "enabled": true,
    "url": "https://hooks.slack.com/services/...",
    "format": "auto",
    "secret": "a-long-random-string",
    "events": { "reviewReady": true, "failed": true, "blocked": true, "prOpened": false }
  },
  "project": { "maxParallelTasks": 2, "defaultTokenBudget": 1000000 }
}
```

- `webhook`: the outcome webhook for the daemon. It is read only from this file, never from the app's `settings.json`. `format` is optional (`auto`, `slack`, `teams` or `discord`) and is detected from the URL when omitted. See [notifications-and-webhooks.md](notifications-and-webhooks.md). An invalid URL stops the daemon with exit code 1. The daemon sends it only when `enabled` is `true`, and it does not read `APERANT_WEBHOOK_URL` or `APERANT_WEBHOOK_SECRET`. `secret` is optional and signs the requests; for the daemon it comes from this file only. `run` reads the same `url` and `events` but ignores `enabled`: for `run`, a URL is enough.
- `project.maxParallelTasks`: how many tasks run at once. Default: 3.
- `project.defaultTokenBudget`: optional [token budget](#token-budget) for queued builds without a task value. Use a positive whole number or omit it for no default.

### Stopping

On SIGTERM or SIGINT the daemon stops the schedule checks, aborts the running tasks and waits up to `--shutdown-timeout` seconds. Each interrupted task goes back to the Queue, with its stuck subtasks reset, and resumes on the next start. Tasks that do not stop in time are put back the same way. The lock is then released and the exit code is 0. A second signal forces an immediate exit with code 1; the tasks that were running are then recovered at the next start, which puts any task still marked running back in the Queue.

### Exit codes for serve

| Code | Meaning |
|------|---------|
| 0 | Stopped cleanly. |
| 1 | Error: bad arguments, no git repository, an invalid config file, or a forced exit. |
| 3 | The project queue is held by another process. |

### systemd example

```ini
[Unit]
Description=Aperant queue and schedules
After=network-online.target

[Service]
WorkingDirectory=/srv/my-project
Environment=ANTHROPIC_API_KEY=...
ExecStart=/usr/bin/node /opt/aperant/apps/desktop/out/main/cli.js serve --config /etc/aperant/serve.json
Restart=on-failure
RestartPreventExitStatus=3
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

`RestartPreventExitStatus=3` stops systemd from restarting the daemon in a loop while the app holds the lock. Keep `TimeoutStopSec` above `--shutdown-timeout`. Prefer an `EnvironmentFile=` with restricted permissions to a key written in the unit.
