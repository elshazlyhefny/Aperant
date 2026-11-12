# Recurring Tasks

A schedule adds one queued task from a template on a cadence. Each time the schedule is due, the app creates a task from the template, puts it in the Queue, and starts it when the project has room. You open schedules from the sidebar item **Schedules** (shortcut **S**).

## Creating, pausing, editing and deleting a schedule

Click **New schedule** and fill in the form:

| Field | Meaning |
|-------|---------|
| **Schedule name** | A label for the schedule, for example "Weekly dependency update". Required. |
| **Task title** | The title of every task the schedule creates. Required. |
| **Task instructions** | What the agent should do on each run. Required. |
| **Cadence** | Daily, Weekly or Custom. See [Cadence types](#cadence-types). |
| **Token budget per run** | The most tokens one run may use. See [Token budget per run](#token-budget-per-run). |

A new schedule is Active. Each schedule in the list shows its status (**Active** or **Paused**), its next run, its last run and its **Run history**.

- **Pause.** A paused schedule creates no tasks and has no next run.
- **Resume.** The next run is counted from the moment you resume. The time the schedule was paused is never reported as missed.
- **Edit.** Changes the name, task template, cadence and budget. The next run is recalculated from the moment you save. Saving an edit does not change whether the schedule is Active or Paused.
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

- **The app must be open.** The scheduler runs in the app's main process, so the Kanban view does not need to be open. A closed app runs nothing.
- **When it checks.** The first check happens 10 seconds after launch, then one every 30 seconds.
- **One task per run.** Each run creates one task and adds it to the Queue.
- **Starting.** Scheduled tasks start only while the project is under its parallel limit (the project setting `maxParallelTasks`, default 3). Otherwise they wait in the Queue.

## Missed runs

A run is recorded as **missed** when it is more than 5 minutes late, or when more than one run has become due since the last check. This happens, for example, when the app was closed over the time of a run.

Only one catch-up task is created, and the history entry records how many runs were missed.

Why one task instead of seven? A task from the same template does the same work each time. If the app was closed for a week, seven identical tasks would repeat the same work and use seven budgets, while one task brings things up to date. The record tells you how many runs you missed, so you can decide whether to start more.

The missed entry is also shown in the **Needs your attention** banner on the Schedules page until you click **Dismiss**.

## History entries explained

Each schedule keeps its latest 50 entries under **Run history**.

| Entry | Meaning | What to do |
|-------|---------|------------|
| **started** ("Started a task") | The run created a task and put it in the Queue. | Nothing. |
| **missed** ("Missed N runs, one catch-up run was started") | More than 5 minutes late, or several runs were due at once. One catch-up task was created. | Read the count, then click **Dismiss**. |
| **skipped_unfinished** ("Skipped because the previous task is unfinished") | The task from the previous run was not yet Done, PR Created or failed, so the due run was dropped. It is not queued later. The next run is rescheduled. Archived tasks count as finished. | Finish or stop the previous task, or give the schedule a longer cadence. Then click **Dismiss**. |
| **budget_exceeded** ("Token budget exceeded") | The task was stopped after it reached the token budget. The detail shows tokens used against the budget. | Review the task. Raise the budget or narrow the instructions if needed. |
| **failed** ("Failed to start") | The task could not be created. The error is stored as the entry's detail. | Check the project and the task template, then wait for the next run. |

The entries other than "started" appear in the **Needs your attention** banner until dismissed.

## Token budget per run

The default is 2,000,000 tokens, input plus output, for each run. The usage of a task is read only after each agent session ends. A run can therefore slightly exceed the budget before it is stopped.

## Where schedules are stored

Schedules are stored in `schedules.json` in the app's user data folder. They belong to the machine, not to the repository, and are not shared through git. If the file is missing or corrupt, the app reads it as having no schedules, and nothing runs.

## Troubleshooting

**It did not run overnight.** The app must be open. If it was closed, the next check after launch records a missed run and creates one catch-up task. If it was open, check that the schedule is **Active** and look at its **Run history**.

**One task appeared instead of several.** That is the catch-up behaviour. Look for a "Missed N runs" entry in the history.

**A run was skipped.** The previous task was still not Done, PR Created or failed. Look for the "Skipped because the previous task is unfinished" entry. Finish the previous task, or archive it.

**Nothing starts although tasks are queued.** The project may be at its parallel limit (`maxParallelTasks`, default 3). Scheduled tasks start when a running task finishes. Also check that the app is open.

## Keeping the code and this guide in sync

The scheduler is implemented in `apps/desktop/src/main/schedule-service.ts`, and the time rules (cadence, next run, due counting) in `apps/desktop/src/shared/utils/schedule-time.ts`. If you change the check timing, the missed-run rules, what counts as finished, or the history entries, update this guide too.
