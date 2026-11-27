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

- Node 22 or newer.
- Dependencies installed with `npm run install:all`.
- A build: `npm run build` in `apps/desktop`. This produces `apps/desktop/out/main/cli.js`.
- The project is a git repository.
- A spec at `.auto-claude/specs/<id>/spec.md`, or create one with `new`. `.auto-claude/` is gitignored in this repository, so a CI job must create or restore the spec before it runs `run`.

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
  }
}
```

`providerAccounts` uses the same account objects as the app. `globalPriorityOrder` lists account ids in the order to try them. When both are set, the account queue is tried first, then the environment. `project` overrides the main branch, whether to push, extra environment variable names passed to Bash, and the sandbox mode. `project.defaultTokenBudget` sets an optional [token budget](#token-budget) for builds without a task value. A config file that is missing or invalid stops the run with exit code 1.

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

## Running the queue and schedules as a daemon

`serve` runs one project's task queue and its recurring schedules without opening the app, until you stop it. Use it on a server or a machine where the app is not open. It needs the same prerequisites as `run` (Node 22 or newer, a build, a git repository) and the same [credentials](#credentials).

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
- **Schedules.** Due schedules create a task from their template and put it in the Queue. The rules are the same as in the app, including the missed-run rule: a run more than 5 minutes late, or several runs due at once, records one `missed` entry and creates one catch-up task. See [recurring-tasks.md](recurring-tasks.md#missed-runs).
- **Outcomes.** When a task finishes, its status is saved in the project (Human Review for a pass or a QA rejection, Error otherwise) and the [outcome webhook](notifications-and-webhooks.md) is sent if the config file enables it. The Kanban board shows the result when you open the app later.
- **Token budgets.** Queued tasks without a value in `task_metadata.json` inherit `project.defaultTokenBudget` if set, as for [`run`](#token-budget). Schedule budgets are unchanged: the per-run budget overrides the headless default. When a scheduled task stops at its limit, it is set to Error and the schedule records `budget_exceeded`.

### The lock

The daemon takes a lock on the project's queue. The desktop app takes the same lock when it runs the queue. The app and the daemon therefore cannot run the same project at once. If another process holds the lock, `serve` prints

```
Cannot start: project queue is already run by <holder>
```

and exits with code 3. Stop the other process (close the app, or stop the other daemon) and start `serve` again.

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
