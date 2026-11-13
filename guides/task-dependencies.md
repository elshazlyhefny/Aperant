# Task Dependencies

A task can depend on other tasks. A queued task with dependencies is held in the Queue until every task it depends on is finished. The queue then starts it like any other queued task.

## Adding and removing dependencies

You can change a task's dependencies in three places:

- **Task form.** When you create a task, use the "Depends on" picker to search for tasks and add them.
- **Edit dialog.** Open the task's edit dialog and change the "Depends on" list.
- **Detail view.** The task's detail view shows its dependencies. You can add or remove them there.

Each added dependency shows a remove button. Removing the last one leaves the task with "No dependencies".

### Rejected on save

A save is rejected, with an error message, in these cases:

- **Self dependency.** A task cannot depend on itself.
- **Circular dependency.** If A depends on B and B depends on A, directly or through a longer chain, the save fails and the message shows the cycle path.
- **Unknown task.** One of the selected tasks no longer exists.

## How the queue treats a held task

The queue does not stop at a held task. It skips it and starts the next eligible queued task, oldest first. A held task is not treated as a failed start. It is started later, once its dependencies are finished.

## The three states

| State | Meaning | What you see |
|-------|---------|--------------|
| **Ready** | No dependencies, or all of them are finished. | No badge. The queue can start the task. |
| **Waiting** | At least one dependency is not finished yet, and none of them is failed, missing or archived. | "Waiting for *title*", with " +N more" when there are several. |
| **Blocked** | A dependency has failed, no longer exists, or is archived. It will not become finished by itself. | "Held: *title* failed" or "Held: dependency missing". |

Each blocking dependency also shows a reason: "Not finished yet", "PR not merged yet", "Failed", "Task no longer exists" or "Archived".

A blocked task shows this hint: "This task stays held until you remove the dependency, retry the failed task, or move this task."

## When is a dependency finished?

**A dependency is finished only when its task is in Done.** Nothing else counts.

| Dependency's state | Finished? | Notes |
|--------------------|-----------|-------|
| Done | Yes | |
| PR Created | No | While the PR is open, the dependents stay held, with the reason "PR not merged yet". The code is not on the base branch yet. |
| Human Review (even "completed") | No | |
| AI Review | No | |
| Failed | No | The dependents are held and labelled "Held: *title* failed". |
| Deleted | No | The dependents are held, labelled "Held: dependency missing". |
| Archived | No | The dependents are held, with the reason "Archived". |

### Tasks that land through a pull request

A task that lands through a pull request stays in **PR Created** while the PR is open. After the PR is merged, the task counts as finished once you move it to Done. Nothing moves it automatically today, so you do that move yourself.

### Failed dependencies

A failed dependency leaves its dependents held and labelled. They stay held until you do one of these:

- retry the dependency,
- remove the dependency from the dependent task, or
- move the dependent task.

## Explicit moves are not blocked

Dependencies only gate the automatic start from the queue. If you drag a held task straight to In Progress, that is an explicit action by you, and it is not blocked.

## Planned file overlap warnings

A warning appears when tasks in the same project plan to change the same files. Two such tasks that run at the same time are likely to cause merge conflicts later. The warning is advisory: it tells you early, and you decide what to do.

### Which tasks are compared

Only tasks in the same project are compared with each other.

| Task state | Compared? |
|------------|-----------|
| Backlog | Yes |
| Queue | Yes |
| In Progress | Yes |
| AI Review | Yes |
| Human Review | Yes |
| Done | No |
| PR Created | No |
| Failed | No |
| Archived (any state) | No |

### Where planned files come from

Planned files come from the task's implementation plan. For each subtask, the list is the union of its `files_to_modify` and `files_to_create`. Blank entries and entries that are not text are ignored. The task's list is the deduplicated union over all its subtasks.

Paths are normalized before they are compared: surrounding spaces are trimmed, `\` becomes `/`, and a leading `./` is removed. After that, two files match only when the paths are exactly equal:

- No case folding.
- No folder or wildcard matching.
- `../` and absolute paths are not resolved.

The list is only as good as the plan. Plans are written by an AI, so they can miss files or list extra ones. Plan files are created when the planner runs, so a task that has not been planned yet has no files.

### Unknown planned files

A task with no subtasks, or none of whose subtasks lists a file, has unknown planned files. The detail view says "Planned files are unknown because the plan lists no files."

An unknown task never overlaps with anything, in either direction, so the warning only fires on real evidence. **No warning is not a guarantee that there will be no conflict.**

### What you see

- **On the card.** A warning badge shows "Overlaps with *title*", or "Overlaps with *title* +N" when several tasks overlap. Hovering shows "*title*: N shared file(s)" for each task. The badge is hidden for Done and archived tasks.
- **In the detail view.** The box "Planned files overlap with another task" lists each other task with its shared files (sorted alphabetically, in a scrollable list) and a "Wait for *title*" button.
- **Without overlap.** The detail view says "No planned file overlap with other active tasks was found."

### Waiting for the other task

"Wait for *title*" does **not** add an entry to the task's "Depends on" list or to `metadata.taskDependencies`. It sets a separate hold, `metadata.holdUntilTaskId`, on the task. A task has one such blocker at a time. The hold shows as the "Waiting for *title*" badge on the card and in the detail view, which also has a "Stop waiting" button. The "Wait for" button is shown only while no hold is active.

While the hold is active:

- The queue skips the task, like a held dependency, and starts the next eligible one.
- If you start the task by hand or drag it to In Progress, it goes to Queue instead, with the message "Task "*title*" is held in the queue until the overlapping task finishes."
- The task starts once the hold ends.

### When the hold ends

The hold ends when the other task:

- reaches Human Review, Done or PR Created, or
- is deleted or archived.

> **This differs from task dependencies.** A dependency is finished only in Done. A hold ends earlier, at Human Review, because the question here is whether the other task has finished writing code, not whether it has landed on the base branch.

If the other task fails, the hold stays active, because Failed is not one of the finishing states. Click "Stop waiting", or move the other task on.

### The merge step is the final check

Nothing stops two overlapping tasks from running at the same time unless you choose to wait. The merge step still detects and resolves conflicts (`apps/desktop/src/main/ai/merge/conflict-detector.ts`), and that is the final check. The warning only helps you avoid conflicts early.

## `taskDependencies` and `dependencies`

Task metadata has two separate fields:

- `metadata.taskDependencies` holds the task ids described in this guide. It is the only field that holds a task back.
- `metadata.dependencies` is free text that roadmap features carry over, such as a description of what a feature needs. It is shown for information and has no effect on the queue.

## Keeping the code and this guide in sync

The rules are implemented once, in `apps/desktop/src/shared/utils/task-dependencies.ts`. The main process (queue and save validation) and the renderer (picker and badges) both use it. If you change what counts as finished, update this guide too.

The overlap rules live in `apps/desktop/src/shared/utils/file-overlap.ts`. Update this guide if the compared statuses, the file sources or `FINISHED_TASK_STATUSES` change.
