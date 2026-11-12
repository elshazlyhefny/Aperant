# Token Budgets

A token budget caps how many tokens one task may use. When the task reaches the cap, it pauses instead of running on. You can set a default for a whole project and override it for single tasks.

## What a budget covers

A budget applies to the planning, coding and QA sessions of a task, on both agent engines. It does not apply to spec creation, Insights or the other utility runners.

## Where to set it

- **Project default.** Open Project settings > GitHub integration and fill in "Token budget". Leave it blank for no budget. Otherwise enter a whole number greater than 0.
- **Per task.** The task creation form and the task edit dialog both have a "Token budget" field. Under it, a hint shows "Project default: N tokens" or "Project default: none". The checkbox "No limit for this task" turns the limit off for that task.

## Which value wins

| Situation | Effective budget |
|-----------|------------------|
| Task has a positive value | The task value, whatever the project says. |
| Task value is 0 ("No limit for this task") | Unlimited, even when the project has a limit. |
| Task field is blank | Inherits the project value. |
| Task value in `task_metadata.json` is invalid or negative | Unlimited. |
| No task value and no project value | No budget. |

Example, with a project limit of 1,000,000 tokens:

| Task setting | Effective budget |
|--------------|------------------|
| Blank | 1,000,000 |
| 500,000 | 500,000 |
| 3,000,000 | 3,000,000 |
| 0 ("No limit for this task") | Unlimited |
| -5 (written by hand in `task_metadata.json`) | Unlimited |

If the project has no limit, a blank task field means no budget, and a positive task value still applies.

## What counts

Input tokens plus output tokens. Cache read and cache creation tokens are not added, because the input count already includes cached input, so adding them would count the same tokens twice.

Usage is cumulative across all sessions of the task. It is read from the task's `run_metrics.json`, not counted per session.

The limit is checked before every model request and after each finished step. A run can therefore end slightly above the limit.

## What happens at the limit

The task pauses in Human Review. It shows the "Token Budget Reached" badge and a "Paused: token budget reached" banner that reads "Paused: X of Y tokens used". The task is never marked complete. Its worktree and completed subtasks are kept.

## Resuming a paused task

The banner has these controls:

- **New token limit.** A field prefilled with the current limit plus 50%.
- **Unlimited.** A checkbox that removes the limit.
- **Raise limit and resume.** Saves the choice and restarts the task.

The new value is saved on the task, so it overrides the project default from then on. Usage is cumulative, so resuming without raising the limit pauses the task again immediately.

## Schedules

Every schedule has a "Token budget per run" field. It is required: a positive whole number, with a default of 2,000,000.

- The value is written into every task the schedule creates, so it overrides the project default.
- It is checked between agent sessions.
- A run that is stopped for this reason is recorded in the schedule history as "Token budget exceeded".

## Headless runs

The CLI reads only the task's own `task_metadata.json`. It does not use the project default. See [CLI-USAGE.md](CLI-USAGE.md#token-budget).

## Keeping the code and this guide in sync

The budget rules are implemented in `apps/desktop/src/shared/utils/token-budget.ts`. The main process and the renderer both use it. If you change how the budget is counted or resolved, update this guide too.
