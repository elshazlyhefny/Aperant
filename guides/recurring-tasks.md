# Recurring Tasks

A schedule creates tasks from a template on a cadence. New tasks go into the Queue and start when the project has room. You open schedules from the sidebar item **Schedules** (shortcut **S**).

## Creating, pausing, editing and deleting a schedule

Click **New schedule** and fill in the form:

| Field | Meaning |
|-------|---------|
| **Schedule name** | A label for the schedule, for example "Weekly dependency update". Required. |
| **Task title** | The title of every task the schedule creates. Required. |
| **Task instructions** | What the agent should do on each run. Required. |
| **Cadence** | Daily, Weekly or Custom. See [Cadence types](#cadence-types). |
| **Missed runs** | Run one catch-up task (default), or skip and wait for the next run. See [Missed runs](#missed-runs). |
| **Token budget per run** | The most tokens one run may use. See [Token budget per run](#token-budget-per-run). |

A new schedule is Active. Each schedule in the list shows its status (**Active** or **Paused**), its next run, its last run and its **Run history**.

- **Pause.** A paused schedule creates no tasks and has no next run.
- **Resume.** The next run is counted from the moment you resume. The time the schedule was paused is never reported as missed.
- **Edit.** Changes the name, task template, cadence, missed-run policy and budget. The next run is recalculated from the moment you save. Saving an edit does not change whether the schedule is Active or Paused.
- **Delete.** Removes the schedule after you confirm. Tasks it already created are kept.

## Cadence types

All times are local time on your machine.

| Cadence | Setting | Example |
|---------|---------|---------|
| **Daily** | A time, `HH:MM`. | Daily at 02:00 |
| **Weekly** | One or more days (Sun to Sat) and a time, `HH:MM`. | Mon at 09:00 |
| **Custom** | Every N minutes. The minimum is 15. | Every 60 minutes |

Examples:

- **Weekly dependency update.** Weekly, Mon, 09:00, with instructions that describe the update you want.
- **Nightly test-health check.** Daily, 02:00, with instructions that describe which tests to run and what to report.

## When does a schedule run?

- **The app or the daemon must be running.** The scheduler runs in the app's main process, so the Kanban view does not need to be open. A closed app runs nothing, unless you run the queue as a daemon instead; see [Running the queue and schedules as a daemon](CLI-USAGE.md#running-the-queue-and-schedules-as-a-daemon). The app and the daemon cannot run the same project at once. See [Using the desktop app while serve runs](CLI-USAGE.md#using-the-desktop-app-while-serve-runs).
- **When it checks.** The first check happens 10 seconds after launch, then one every 30 seconds.
- **No backlog of tasks.** Each check creates at most one task per schedule, even if several runs are due. The rules below determine whether to create a task or skip the run.
- **Starting.** Scheduled tasks start only while the project is under its parallel limit (the project setting `maxParallelTasks`, default 3). Otherwise they wait in the Queue.

## Missed runs

A run counts as missed when it is more than 5 minutes late, or when several runs are due at once. This can happen when the app is closed or the machine is off. The app and daemon (`cli.js serve`) use the same rule.

Choose how each schedule handles missed runs:

- **Run one catch-up task.** This is the default. Existing schedules keep this behaviour unless you change it. The scheduler creates one task, even if several runs were missed. The `missed` history entry shows how many runs were missed and appears in **Needs your attention** until you click **Dismiss**.
- **Skip and wait for the next run.** When the same rule marks a run as missed, the scheduler creates no task. A `skipped_missed` history entry shows how many runs were skipped, and the next run stays on the original cadence. Choose this for work that's only useful at its scheduled time.

With either choice, an unfinished task from the previous run takes precedence. The scheduler records `skipped_unfinished` instead of applying the missed-run policy. On-time runs, token budgets and **Run now** are unaffected by this setting.

## History entries explained

Each schedule keeps its latest 50 entries under **Run history**.

| Entry | Meaning | What to do |
|-------|---------|------------|
| **started** ("Started a task") | The run created a task and put it in the Queue. | Nothing. |
| **missed** ("Missed N runs, one catch-up run was started") | More than 5 minutes late, or several runs were due at once. One catch-up task was created. | Read the count, then click **Dismiss**. |
| **skipped_missed** ("Missed N runs, skipped as set for this schedule") | The schedule was set to skip missed runs, so no task was created. | Nothing. This is informational and does not appear in **Needs your attention**. |
| **skipped_unfinished** ("Skipped because the previous task is unfinished") | The task from the previous run was not yet Done, PR Created or failed, so the due run was dropped. It is not queued later. The next run is rescheduled. Archived tasks count as finished. | Finish or stop the previous task, or give the schedule a longer cadence. Then click **Dismiss**. |
| **budget_exceeded** ("Token budget exceeded") | The task was stopped after it reached the token budget. The detail shows tokens used against the budget. | Review the task. Raise the budget or narrow the instructions if needed. |
| **failed** ("Failed to start") | The task could not be created. The error is stored as the entry's detail. | Check the project and the task template, then wait for the next run. |

The `missed`, `skipped_unfinished`, `budget_exceeded` and `failed` entries appear in the **Needs your attention** banner until dismissed.

## Token budget per run

The default is 2,000,000 tokens, input plus output, for each run. The usage of a task is read only after each agent session ends. A run can therefore slightly exceed the budget before it is stopped.

## Where schedules are stored

Schedules are stored in `schedules.json` in the app's user data folder. They belong to the machine, not to the repository, and are not shared through git. If the file is missing or corrupt, the app reads it as having no schedules, and nothing runs. The daemon reads `<project>/.auto-claude/schedules.json` by default, or the file given with `--schedules`.

## Troubleshooting

**It did not run overnight.** The app (or the daemon) must be running. After a restart, check **Run history** to see whether the schedule caught up, skipped missed runs, or skipped because the previous task was unfinished. If there is no new entry, check that the schedule is **Active**.

**One task appeared instead of several.** With **Run one catch-up task**, the scheduler creates just one task for all missed runs. Look for "Missed N runs, one catch-up run was started" in the history.

**A run was skipped.** Check **Run history**. "Missed N runs, skipped as set for this schedule" means the skip policy worked as intended. "Skipped because the previous task is unfinished" means you should finish or archive the previous task.

**Nothing starts although tasks are queued.** The project may be at its parallel limit (`maxParallelTasks`, default 3). Scheduled tasks start when a running task finishes. Also check that the app or the daemon is running.

**Schedules do not run in the app and the Kanban banner names a daemon as the queue owner.** A `serve` daemon holds the project's queue lock, so the app pauses its queue and schedules for that project. The daemon runs schedules from its own schedules file. Due runs in the app stay due until the lock is released. See [Using the desktop app while serve runs](CLI-USAGE.md#using-the-desktop-app-while-serve-runs).

## Keeping the code and this guide in sync

The scheduler is implemented in `apps/desktop/src/main/schedule-service.ts`, and the time rules (cadence, next run, due counting) in `apps/desktop/src/shared/utils/schedule-time.ts`. If you change the check timing, the missed-run rules or `missedRunPolicy`, what counts as finished, or the history entries, update this guide too.
