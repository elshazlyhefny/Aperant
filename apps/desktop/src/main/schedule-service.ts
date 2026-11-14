/**
 * zeenha fork: scheduler for recurring tasks. Runs in the main process (the
 * renderer queue may not be mounted). Every 30s it adds one queued task for
 * each due schedule, then starts schedule-owned queued tasks while the project
 * is under its parallel limit. Dependencies are injected so it can be tested.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getSpecsDir } from '../shared/constants/config';
import { readRunMetrics } from './ai/logging/run-metrics';
import { findTaskWorktree } from './worktree-paths';
import type { Project, Task } from '../shared/types';
import type {
  RecurringSchedule,
  ScheduleRunNowResult,
  ScheduleRunRecord,
  ScheduleTemplate,
} from '../shared/types/schedule';
import { advancePast, computeNextRun } from '../shared/utils/schedule-time';

/** Same default as the renderer queue (renderer/stores/task-store.ts). */
const DEFAULT_MAX_PARALLEL_TASKS = 3;
const TICK_INTERVAL_MS = 30_000;
const FIRST_TICK_DELAY_MS = 10_000;
/** A run later than this after its due time counts as a missed run (app was closed). */
export const MISSED_GRACE_MS = 5 * 60_000;

const FINISHED_STATUSES = new Set(['done', 'pr_created', 'error']);

export interface ScheduleServiceDeps {
  now(): number;
  listSchedules(): RecurringSchedule[];
  saveSchedule(schedule: RecurringSchedule): void;
  getProject(projectId: string): Project | undefined;
  listTasks(projectId: string): Task[];
  /** Create the spec in status 'queue'; returns the new task id. */
  createTask(projectId: string, template: ScheduleTemplate, scheduleId: string, scheduledFor: number): Promise<string>;
  startTask(taskId: string): Promise<void>;
  isRunning(taskId: string): boolean;
  notifyChanged(projectId: string): void;
  /** Total tokens (input + output) a task has used so far; 0 when unknown. Never throws. */
  readTaskTokens(projectId: string, specId: string): number;
  /** Stops a running task (execution-handlers stopTask; it emits USER_STOPPED itself). */
  stopTask(taskId: string): void;
  /** False while another process holds the project's queue lock; the run stays due. */
  canRun?(projectId: string): boolean;
}

function sumTokens(directory: string): number {
  return readRunMetrics(directory).reduce((sum, s) => sum + (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0), 0);
}

/**
 * Real `readTaskTokens`: the larger of the main spec dir and the worktree spec
 * dir. In worktree mode each session is written to both, so adding them would
 * double count.
 */
export function readTaskTokensFromDisk(project: Project, specId: string): number {
  try {
    const specsRel = getSpecsDir(project.autoBuildPath);
    let best = sumTokens(path.join(project.path, specsRel, specId));
    const worktree = findTaskWorktree(project.path, specId);
    if (worktree) best = Math.max(best, sumTokens(path.join(worktree, specsRel, specId)));
    return best;
  } catch {
    return 0;
  }
}

export interface ScheduleService {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  onAgentExit(taskId: string): void;
  /** zeenha fork: manual run; leaves nextRunAt and enabled untouched. */
  runNow(scheduleId: string): Promise<ScheduleRunNowResult>;
}

function record(kind: ScheduleRunRecord['kind'], at: number, extra: Partial<ScheduleRunRecord> = {}): ScheduleRunRecord {
  return { id: randomUUID(), at, kind, acknowledged: false, ...extra };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createScheduleService(deps: ScheduleServiceDeps): ScheduleService {
  let timer: ReturnType<typeof setInterval> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let ticking = false;
  let rerun = false;
  const starting = new Set<string>();
  const budgetStopped = new Set<string>();
  /** Schedule ids with a manual run in progress; processSchedule skips them. */
  const inFlight = new Set<string>();

  function allowed(projectId: string): boolean {
    try {
      return deps.canRun ? deps.canRun(projectId) : true;
    } catch {
      return true;
    }
  }

  function isUnfinished(projectId: string, taskId: string | undefined): boolean {
    if (!taskId) return false;
    const task = deps.listTasks(projectId).find((t) => t.id === taskId);
    if (!task) return false;
    if (task.metadata?.archivedAt) return false;
    return !FINISHED_STATUSES.has(task.status);
  }

  async function processSchedule(schedule: RecurringSchedule, project: Project, now: number): Promise<boolean> {
    if (inFlight.has(schedule.id)) return false;
    if (!allowed(project.id)) return false;
    if (!schedule.enabled || schedule.nextRunAt === null || schedule.nextRunAt > now) return false;
    inFlight.add(schedule.id);
    try {
      return await processDue(schedule, schedule.nextRunAt, project, now);
    } finally {
      inFlight.delete(schedule.id);
    }
  }

  async function processDue(
    schedule: RecurringSchedule,
    firstDue: number,
    project: Project,
    now: number
  ): Promise<boolean> {
    const { dueCount, nextRunAt } = advancePast(schedule.cadence, firstDue, now);
    if (dueCount === 0) return false;

    const next: RecurringSchedule = { ...schedule, nextRunAt, history: [...schedule.history] };

    if (isUnfinished(project.id, schedule.lastTaskId)) {
      next.history.push(record('skipped_unfinished', now, { taskId: schedule.lastTaskId, detail: `${dueCount} due` }));
      deps.saveSchedule(next);
      return true;
    }

    if (dueCount > 1 || now - firstDue > MISSED_GRACE_MS) {
      next.history.push(
        record('missed', now, { missedCount: dueCount, missedFrom: firstDue, missedTo: lastDue(schedule, firstDue, now, dueCount) })
      );
    }

    try {
      const taskId = await deps.createTask(project.id, schedule.template, schedule.id, firstDue);
      next.lastRunAt = now;
      next.lastTaskId = taskId;
      next.history.push(record('started', now, { taskId }));
    } catch (error) {
      next.history.push(record('failed', now, { detail: errorMessage(error) }));
    }
    deps.saveSchedule(next);
    return true;
  }

  /** The last occurrence at or before `now`. */
  function lastDue(schedule: RecurringSchedule, firstDue: number, now: number, dueCount: number): number {
    if (schedule.cadence.kind === 'interval') {
      return firstDue + (dueCount - 1) * schedule.cadence.everyMinutes * 60_000;
    }
    let at = firstDue;
    for (let i = 1; i < dueCount; i++) {
      const following = computeNextRun(schedule.cadence, at);
      if (following > now) break;
      at = following;
    }
    return at;
  }

  async function promote(projectIds: Set<string>): Promise<void> {
    for (const projectId of projectIds) {
      try {
        const project = deps.getProject(projectId);
        if (!project || !allowed(projectId)) continue;
        const tasks = deps.listTasks(projectId).filter((t) => !t.metadata?.archivedAt);
        let active = tasks.filter((t) => t.status === 'in_progress' || deps.isRunning(t.id) || starting.has(t.id)).length;
        const limit = project.settings?.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
        const queued = tasks
          .filter((t) => t.status === 'queue' && t.metadata?.scheduleId && !starting.has(t.id) && !deps.isRunning(t.id))
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        for (const task of queued) {
          if (active >= limit) break;
          starting.add(task.id);
          try {
            await deps.startTask(task.id);
            active++;
          } catch {
            // Stays queued; retried on the next tick
          } finally {
            starting.delete(task.id);
          }
        }
      } catch {
        // One project failing must not stop the others
      }
    }
  }

  /**
   * Stops scheduled tasks that reached their token budget. Usage is appended to
   * run_metrics.json only when an agent session ends, so the ceiling is enforced
   * between sessions, not mid-session.
   */
  function enforceBudgets(projectIds: Set<string>): void {
    let schedules: RecurringSchedule[];
    try {
      schedules = deps.listSchedules();
    } catch {
      return;
    }
    for (const projectId of projectIds) {
      try {
        if (!allowed(projectId)) continue;
        for (const task of deps.listTasks(projectId)) {
          const scheduleId = task.metadata?.scheduleId;
          if (!scheduleId || budgetStopped.has(task.id) || task.metadata?.archivedAt) continue;
          if (FINISHED_STATUSES.has(task.status)) continue;
          if (!(task.status === 'in_progress' || deps.isRunning(task.id))) continue;
          const schedule = schedules.find((s) => s.id === scheduleId);
          const budget = task.metadata?.tokenBudget ?? schedule?.template.tokenBudget;
          if (!budget || budget <= 0) continue;
          let used = 0;
          try {
            used = deps.readTaskTokens(projectId, task.specId);
          } catch {
            used = 0;
          }
          if (used < budget) continue;
          budgetStopped.add(task.id);
          try {
            deps.stopTask(task.id);
          } catch {
            // Still record below; the task is not retried
          }
          if (schedule) {
            const fresh = deps.listSchedules().find((s) => s.id === schedule.id) ?? schedule;
            deps.saveSchedule({
              ...fresh,
              history: [...fresh.history, record('budget_exceeded', deps.now(), { taskId: task.id, detail: `${used}/${budget}` })],
            });
          }
          deps.notifyChanged(projectId);
        }
      } catch {
        // One project failing must not stop the others
      }
    }
  }

  function scheduledProjectIds(): Set<string> {
    const ids = new Set<string>();
    try {
      for (const s of deps.listSchedules()) ids.add(s.projectId);
    } catch {
      // ignore
    }
    return ids;
  }

  async function tick(): Promise<void> {
    if (ticking) {
      rerun = true;
      return;
    }
    ticking = true;
    try {
      const now = deps.now();
      const changed = new Set<string>();
      let schedules: RecurringSchedule[] = [];
      try {
        schedules = deps.listSchedules();
      } catch {
        return;
      }
      for (const schedule of schedules) {
        try {
          const project = deps.getProject(schedule.projectId);
          if (!project) continue;
          if (await processSchedule(schedule, project, now)) changed.add(project.id);
        } catch {
          // Isolated: one broken schedule never blocks the rest
        }
      }
      await promote(scheduledProjectIds());
      enforceBudgets(scheduledProjectIds());
      for (const projectId of changed) {
        try {
          deps.notifyChanged(projectId);
        } catch {
          // ignore
        }
      }
    } catch {
      // never throws
    } finally {
      ticking = false;
      if (rerun) {
        rerun = false;
        void tick();
      }
    }
  }

  async function runNow(scheduleId: string): Promise<ScheduleRunNowResult> {
    let schedule: RecurringSchedule | undefined;
    try {
      schedule = deps.listSchedules().find((s) => s.id === scheduleId);
    } catch {
      return { started: false, reason: 'not_found' };
    }
    if (!schedule) return { started: false, reason: 'not_found' };
    const project = deps.getProject(schedule.projectId);
    if (!project) return { started: false, reason: 'not_found' };
    if (inFlight.has(schedule.id)) return { started: false, reason: 'unfinished' };
    if (!allowed(project.id)) return { started: false, reason: 'locked' };

    inFlight.add(schedule.id);
    let result: ScheduleRunNowResult;
    try {
      const now = deps.now();
      const history = [...schedule.history];
      if (isUnfinished(project.id, schedule.lastTaskId)) {
        history.push(record('skipped_unfinished', now, { taskId: schedule.lastTaskId, detail: 'manual' }));
        deps.saveSchedule({ ...schedule, history });
        result = { started: false, reason: 'unfinished', taskId: schedule.lastTaskId };
      } else {
        try {
          const taskId = await deps.createTask(project.id, schedule.template, schedule.id, now);
          history.push(record('started', now, { taskId, detail: 'manual' }));
          deps.saveSchedule({ ...schedule, lastRunAt: now, lastTaskId: taskId, history });
          result = { started: true, taskId };
        } catch (error) {
          history.push(record('failed', now, { detail: errorMessage(error) }));
          deps.saveSchedule({ ...schedule, history });
          result = { started: false };
        }
      }
      deps.notifyChanged(project.id);
    } finally {
      inFlight.delete(schedule.id);
    }
    await tick();
    return result;
  }

  return {
    runNow,
    start() {
      if (timer) return;
      firstTimer = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
      firstTimer.unref?.();
      timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (firstTimer) clearTimeout(firstTimer);
      timer = null;
      firstTimer = null;
    },
    tick,
    onAgentExit(_taskId: string) {
      void (async () => {
        if (ticking) {
          rerun = true;
          return;
        }
        await promote(scheduledProjectIds());
        enforceBudgets(scheduledProjectIds());
      })();
    },
  };
}
