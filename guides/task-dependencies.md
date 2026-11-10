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

## `taskDependencies` and `dependencies`

Task metadata has two separate fields:

- `metadata.taskDependencies` holds the task ids described in this guide. It is the only field that holds a task back.
- `metadata.dependencies` is free text that roadmap features carry over, such as a description of what a feature needs. It is shown for information and has no effect on the queue.

## Keeping the code and this guide in sync

The rules are implemented once, in `apps/desktop/src/shared/utils/task-dependencies.ts`. The main process (queue and save validation) and the renderer (picker and badges) both use it. If you change what counts as finished, update this guide too.
