# Delivery Timing

The project's **Delivery** view breaks down how long tasks take to become ready for human review. Use it to tell whether time is going into queue wait, execution, or pauses such as unavailable credentials or provider rate limits.

## What is measured

The clock starts at the first recorded queue entry, or at the start of execution if the task starts without queueing. It stops at the first successful QA outcome: `human_review` with `reviewReason: 'completed'`. Moving a task into Human Review is not enough. A credential or budget pause, a QA rejection, or a manual move without a recorded QA pass does not stop the clock.

Only the first queue-to-review-ready cycle is measured. Resumes and retries before QA passes are part of that cycle. Work after the first QA pass, such as changes requested by a human reviewer, is not included.

## Where the time goes

Each transition starts an interval that lasts until the next recorded transition. Intervals of the same kind are added together, so queue wait after a pause counts as queue wait, not as part of the pause.

| Segment | What counts |
|---------|-------------|
| Queue wait | Time in `queue`, including time spent waiting after a requeue. |
| Active execution | Time in `in_progress` or `ai_review`, including automated QA. This is elapsed time in those states, not agent compute time. |
| Credential or rate-limit pause | Time in `human_review` with `reviewReason: 'account_required'`, or time marked with `pause: 'credential'`. No usable account was available. |
| Budget pause | Time in `human_review` with `reviewReason: 'token_budget'` on desktop, or time marked with `pause: 'budget'` (the daemon keeps its `error` status). |
| Other | Time in any remaining state within the cycle, such as waiting for a fix after QA rejects the work. Time in backlog before the first queue entry or start is excluded. |

For a measured task, the five segments add up to its total queue-to-review-ready time.

## How desktop and daemon agree

Desktop records transitions after saving task status through `plan-file-utils`. The daemon records them through `setTaskStatus` in `headless/task-store.ts`. Both use the same recorder and timing rules, even when they use different statuses for the same pause.

When the daemon recovers a task left running by a previous daemon, it marks the requeue as interrupted. An active interval that ends at an interruption marker or crosses a process-instance change is unknown: the log cannot tell when execution actually stopped. A later QA pass does not make that interval measurable.

## Reading the numbers

Use the period selector to choose the last 7, 30, or 90 days, or all time. Measured tasks are assigned to the period by their first review-ready timestamp. Coverage is the number of measured tasks divided by the number of eligible tasks. The denominator also includes tasks marked Done, PR Created, or Human Review with a completed QA reason that lack a complete timing sample. For those tasks, the latest recorded session start (or the task's update time if there are no usable session timestamps) determines the period. Tasks that are still queued, running, or paused and have not reached an eligible outcome are not counted.

A missing log can indicate an older task. An unreadable log, a log that begins mid-run or lacks a start, interrupted active time, or an open cycle with no recorded QA pass can also leave timing unknown. These yield no duration sample. A measured zero means no time was recorded in that segment of a complete cycle; it does not stand in for missing data.

Each row shows its sample count, median, and 90th percentile (p90). Both percentiles use nearest rank: sort the measured durations shortest to longest and take the value at position `ceil(p × sample count)`, counting from 1, where `p` is 0.5 for the median or 0.9 for p90. With no samples, the view shows a dash instead of a duration. Percentiles are calculated separately for each row, so segment percentiles do not necessarily add up to the total's percentile.

## What stays local

`delivery_timing.json` lives next to the task's plan in its gitignored spec directory (by default, `.auto-claude/specs/<task>/`). The versioned file stores only transition timestamps, current and previous statuses, review reasons, pause and interruption markers, the desktop or daemon source, and an opaque process-instance ID. It never stores prompts, diffs, task titles, or credentials. This data stays local. Older versions ignore the separate file, and it does not change `run_metrics.json`. Recording is best effort: a failed timing write does not stop the task.

## Fixture baseline report

The [controlled-clock scenarios](../apps/desktop/src/main/ai/logging/__tests__/delivery-timing-fixtures.ts) replay the same timelines through both status writers and assert identical results. Expected durations are in minutes. A dash means there is no complete sample; a zero means that segment did not occur in a measured cycle.

| Scenario | Queue to review-ready | Queue wait | Active | Credential or rate-limit pause | Budget pause | Other | Outcome |
|----------|----------------------:|-----------:|-------:|-------------------------------:|-------------:|------:|---------|
| A: Clean delivery | 55 | 10 | 45 | 0 | 0 | 0 | Measured |
| B: Credential pause and requeue | 80 | 15 | 35 | 30 | 0 | 0 | Measured |
| C: Budget pause and direct resume | 52 | 2 | 20 | 0 | 30 | 0 | Measured |
| D: Credential pause without resume | — | — | — | — | — | — | Open; no QA pass |
| E: QA rejected, then fixed | 54 | 4 | 40 | 0 | 0 | 10 | Measured |
| F: Restart recovery while active | — | — | — | — | — | — | Unknown; active time interrupted before QA passed |

For example, the four measured totals sort to 52, 54, 55, and 80 minutes. Their nearest-rank median is 54 minutes and p90 is 80 minutes. In an all-time view of these fixtures, coverage would be 4 of 5 eligible tasks (80%): F passed QA but is unknown, and D is still open.

Reproduce from the repository root:

```bash
cd apps/desktop && npx vitest run src/main/ai/logging/__tests__/delivery-timing-parity.test.ts src/main/ai/logging/__tests__/delivery-timing.test.ts
```

These synthetic fixtures validate the method. They are not production measurements and make no claim about adoption or performance. Collect a real baseline and check its coverage before setting speed targets.
