# Delivery Metrics

The Delivery view shows how many tokens and how much session time your project recorded. The totals include work from any task with usable metrics in the selected period, but the per-completed-task averages count only completed tasks. Use a task's **Usage** tab to check what it contributed.

## Opening the view

Select a project, then choose **Delivery** in the sidebar (shortcut: `E`) to open **Delivery and token usage**. The **Period** selector offers **7 days**, **30 days** (the default), **90 days**, and **All time**. Click **Refresh** to reload the numbers for that period.

## What each card means

| Card | What it counts |
|------|----------------|
| **Tasks scanned** | Tasks selected by the period, including those with missing or unreadable records, except archived tasks and backlog or queued tasks with no metrics. |
| **Completed tasks** | Tasks selected by the period with status `done` or `pr_created` and a readable `run_metrics.json` with at least one usable session. |
| **Total tokens** | Input plus output tokens from every recorded session of the included tasks, regardless of task status. |
| **Total duration** | The sum of those session durations, not the elapsed time from the first session to the last. |
| **Avg tokens per completed task** | Tokens from completed tasks with usable metrics divided by the number of those tasks. Shows `—` if there are none. |
| **Avg duration per completed task** | Session duration from completed tasks with usable metrics divided by the number of those tasks. Shows `—` if there are none. |
| **Failed before any work** | Included tasks with status `error`, whether or not they have recorded sessions. |
| **Avg QA iterations** | The number of `qa_reviewer` sessions divided by the number of included tasks that had at least one, regardless of status. Shows `—` if none had one. |

## How the period picks tasks

A period of N days uses a rolling cutoff of now minus N × 24 hours, not calendar days. A task's time is the start of its newest recorded session. If none of its sessions has a usable start time, Delivery uses the task's last update time. **All time** has no cutoff.

The cutoff applies to whole tasks, not to individual sessions. An included task brings all its recorded sessions, even those older than the cutoff. Switching from **7 days** to **30 days** can raise totals by adding tasks whose latest activity falls between the two cutoffs, along with all their sessions, including ones older than seven days. A task active within the last seven days already brings its older sessions into the **7 days** view.

Archived tasks are never counted. Backlog and queued tasks with no metrics are skipped, even if they were updated within the period.

## Which records count

For tasks in the period, Delivery handles missing and unreadable records this way:

| Record | How it counts |
|--------|---------------|
| Missing file or no valid sessions on a non-error task | **Tasks scanned** and the “without metrics” count, except for backlog and queued tasks. A `done` task with a missing file does not count as completed. |
| File cannot be read, is invalid JSON, or does not contain a JSON object with a `sessions` list | **Tasks scanned** and the “unreadable” count. If its status is `error`, it also counts as failed. |
| Missing file or no valid sessions on an `error` task | **Tasks scanned** and **Failed before any work**, but not the exclusion note. |

None of these records adds sessions, tokens, or duration. When the dashboard is shown and records were excluded, the note reads “X tasks without metrics and Y with unreadable metrics were excluded.” If no task has usable metrics and none count as completed, Delivery shows **No completed or recorded tasks in this period** instead. A period with only failed tasks without metrics hides the failed list for this reason.

## Why cache-read tokens are not added

**Total tokens** is input plus output. Cache-read tokens are already part of input, so adding them would count them twice. Cache-creation tokens are not added separately either. This is the same rule as **Budget tokens (input + output)** on the **Usage** tab and in [token budgets](token-budgets.md#what-counts).

## “Failed before any work” means error status, not zero work

Every included `error` task counts and can appear under **Tasks that failed before any work**, even if it ran sessions. Its sessions still contribute to the totals and the phase and model tables, but the task does not count as completed or contribute to either per-completed-task average. Its QA sessions, if any, still count toward **Avg QA iterations**. The list shows at most 50 tasks and displays “Showing X of Y tasks.” if it is truncated.

## Worked example

Suppose the period includes these three tasks: A (Add login page, `done`), B (Fix date picker, `pr_created`), and C (Migrate settings, `error` after its planning session).

| Task | Session | Input tokens | Output tokens | Duration |
|------|---------|-------------:|--------------:|----------|
| A | Planning | 40,000 (30,000 cache read) | 5,000 | 2m 0s |
| A | Coding | 120,000 (100,000 cache read) | 20,000 | 10m 0s |
| A | QA (`qa_reviewer`) | 30,000 | 3,000 | 3m 0s |
| B | Planning | 20,000 | 2,000 | 1m 0s |
| B | Coding | 60,000 | 10,000 | 6m 0s |
| B | QA (`qa_reviewer`) | 10,000 | 1,000 | 1m 0s |
| C | Planning | 15,000 | 1,000 | 1m 0s |

Adding input and output and summing the session durations gives A **218,000** tokens in **15m 0s**, B **103,000** in **8m 0s**, and C **16,000** in **1m 0s**. A's 130,000 cache-read tokens are already in its input. C's recorded work goes into the totals, but neither C nor its work goes into the per-completed-task averages.

| Card | Result |
|------|--------|
| **Tasks scanned** | 3: A, B, and C |
| **Completed tasks** | 2: A and B |
| **Total tokens** | 337,000 = 218,000 + 103,000 + 16,000 |
| **Total duration** | 24m 0s = 15 min + 8 min + 1 min |
| **Avg tokens per completed task** | 160,500 = (218,000 + 103,000) ÷ 2 |
| **Avg duration per completed task** | 11m 30s = (15 min + 8 min) ÷ 2 |
| **Failed before any work** | 1: C |
| **Avg QA iterations** | 1 = 2 QA sessions ÷ 2 tasks with QA |

If C's only session started 10 days ago and A and B ran yesterday, **7 days** shows only A and B: **Total tokens** is 321,000 and **Failed before any work** is 0. **30 days** shows all three, with 337,000 total tokens and one failure.

## Reconciling with a task's Usage tab

Click a task under **Tasks that failed before any work**. Delivery switches to the Kanban board and opens the task. If the task is not listed, open it directly from the Kanban board. Select the **Usage** tab to see **Run usage**.

The tab has no period filter. When Delivery includes the task's sessions, **Budget tokens (input + output)** equals its share of **Total tokens**, and **Sessions** and **Wall time** match its contribution to Delivery's session counts and **Total duration**. For example, C contributes 16,000 tokens, one session, and 1m 0s in **30 days**. Its **Usage** tab still shows the same values when Delivery is set to **7 days**, even though C no longer contributes to the project totals. A missing or unreadable file shows **No usage recorded yet**.

The **Usage** tab has **By agent type** and **Tool time**, which Delivery does not show. Delivery has **Usage by model**, which the task tab does not show.

## Trend and breakdowns

**Trend by day** groups completed tasks with usable metrics into one row per UTC date, using each task's newest session start (or last update if no start time is usable). It shows the number of completed tasks and their average tokens per task for that date. The UTC date can differ from your local date near midnight. Failed and in-progress tasks are not shown in the trend.

**Usage by phase** and **Usage by model** group sessions from included tasks of any status and sort the rows by total tokens, highest first. A missing phase shows as **Unknown**; a missing model shows as **unknown**.

## What these numbers are not

Both views read recorded tokens and durations from `run_metrics.json` in the main project's `.auto-claude/specs/<task>/` folder by default, not from the worktree. These numbers are not a billing or cost estimate and do not match provider invoices or the [usage monitor](usage-and-account-switching.md), which tracks account usage rather than task sessions. Time lost recovering from rate limits is not recorded separately.
