import type { Project, ReviewReason, Task, TaskStatus, TaskQueueState } from '../shared/types';
import { DEFAULT_MAX_PARALLEL_TASKS } from '../shared/constants/queue';
import { evaluateTaskDependencies } from '../shared/utils/task-dependencies';
import { isHoldActive } from '../shared/utils/file-overlap';
import { extractRateLimitResetAt, isRateLimitReason } from '../shared/utils/rate-limit-reset';
import { appLogPort } from './log-port';

/** Safety limit that stops a pass when promotions keep failing */
const MAX_CONSECUTIVE_FAILURES = 10;

/** zeenha fork: capacity backoff when no reset time is known: 1, 2, 4 ... 30 minutes. */
export const CAPACITY_BACKOFF_BASE_MS = 60_000;
export const CAPACITY_BACKOFF_MAX_MS = 30 * 60_000;
/** setTimeout cannot wait longer than this. */
const MAX_TIMER_MS = 2_147_483_647;

export type QueueState = TaskQueueState;

export interface PromoteResult {
  success: boolean;
  error?: string;
}

/** zeenha fork: whether an account can take a task right now. */
export type CapacityCheckResult = { ok: true } | { ok: false; retryAt?: number; reason: string };

export interface TaskQueueDeps {
  getProjects: () => Project[];
  getTasks: (projectId: string) => Task[];
  promote: (taskId: string, projectId: string) => Promise<PromoteResult>;
  emitState?: (projectId: string, state: QueueState) => void;
  /** zeenha fork: false while another process (the daemon) holds this project's queue lock. */
  canProcess?: (projectId: string) => { ok: true } | { ok: false; heldBy: string; runningTaskIds?: string[] };
  /**
   * zeenha fork: asked right before a task is promoted. When no account can take
   * it, the queue stops promoting and retries at `retryAt` (or after a backoff).
   * Errors count as ok, so a broken check never stalls the queue.
   */
  checkCapacity?: (projectId: string, task: Task) => Promise<CapacityCheckResult>;
}

interface CapacityBlock {
  until: number;
  reason: string;
  estimated: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** zeenha fork: a task that stopped because no account had capacity. */
export interface CapacityStop {
  reason: string;
  retryAt?: number;
}

/**
 * zeenha fork: whether a task's new status means it stopped for lack of account
 * capacity: paused for an account (account_required) or failed on a rate limit.
 */
export function capacityStopFor(
  status: TaskStatus,
  reviewReason?: ReviewReason,
  failureReason?: string
): CapacityStop | undefined {
  const accountPause = status === 'human_review' && reviewReason === 'account_required';
  const rateLimitFailure = status === 'error' && isRateLimitReason(failureReason);
  if (!accountPause && !rateLimitFailure) return undefined;
  const retryAt = extractRateLimitResetAt(failureReason) ?? undefined;
  return {
    reason: failureReason?.trim() || (accountPause ? 'A task paused because no account was available' : 'A task hit a rate limit'),
    ...(retryAt ? { retryAt } : {}),
  };
}

const isActive = (t: Task): boolean => !t.metadata?.archivedAt;
const createdAtMs = (t: Task): number => new Date(t.createdAt).getTime();

/**
 * Main-process queue promotion. Moves the oldest 'queue' tasks to 'in_progress'
 * up to the per-project parallel limit, whichever renderer view is open.
 */
export class TaskQueueManager {
  private deps: TaskQueueDeps | null = null;
  private chains = new Map<string, Promise<void>>();
  private running = new Set<string>();
  private rerun = new Set<string>();
  private promotedIds = new Map<string, Set<string>>();
  private skipped = new Map<string, string[]>();
  // zeenha fork: per-project capacity wait. Six tasks started together used to hit
  // the same exhausted account within seconds; each paused (freeing its slot) and
  // the next queued task went straight into the same limit.
  private capacityBlocks = new Map<string, CapacityBlock>();
  private capacityBackoffSteps = new Map<string, number>();

  constructor(deps?: TaskQueueDeps) {
    if (deps) this.deps = deps;
  }

  configure(deps: TaskQueueDeps): void {
    this.deps = deps;
  }

  /** Process one project, or all projects when omitted. Resolves when the pass(es) finish. */
  async requestProcess(projectId?: string): Promise<void> {
    if (!this.deps) return;
    const ids = projectId ? [projectId] : this.deps.getProjects().map((p) => p.id);
    await Promise.all(ids.map((id) => this.schedule(id)));
  }

  /**
   * Called on every task status change; a task leaving in_progress frees a slot.
   * zeenha fork: `capacityStop` says the task stopped for lack of account capacity,
   * which cools the project down instead of promoting the next task at once.
   */
  async onTaskStatusChanged(
    taskId: string,
    status: TaskStatus,
    projectId?: string,
    capacityStop?: CapacityStop
  ): Promise<void> {
    if (status === 'in_progress') return;
    if (projectId && capacityStop) {
      this.reportCapacityExhausted(projectId, capacityStop.reason, capacityStop.retryAt);
    } else if (projectId && status !== 'queue' && status !== 'backlog') {
      this.noteCapacityUsable(projectId);
    }
    // Any other status event proves the task has left the running state (including a drag back to
    // 'queue'), so the promoted marker must not keep counting it toward capacity.
    this.forgetPromoted(taskId, projectId);
    await this.requestProcess(projectId);
  }

  /**
   * zeenha fork: a task stopped because no account had capacity (it paused with
   * account_required, or failed on a rate limit). The project cools down so the
   * next queued task does not start into the same limit. Call this before
   * onTaskStatusChanged so the pass it triggers already sees the cooldown.
   */
  reportCapacityExhausted(projectId: string, reason: string, retryAt?: number): void {
    if (!this.deps) return;
    // One task's reset can be days away while another account frees up sooner, so a
    // reported stop waits at most the backoff cap; checkCapacity then decides again.
    if (retryAt !== undefined) retryAt = Math.min(retryAt, Date.now() + CAPACITY_BACKOFF_MAX_MS);
    const current = this.activeCapacityBlock(projectId);
    // Tasks running together hit the limit together; one cooldown covers them all.
    if (current && (!retryAt || retryAt <= current.until)) return;
    this.blockCapacity(projectId, reason, retryAt);
  }

  /**
   * zeenha fork: a task got past the account (it reached any status other than
   * a capacity stop), so capacity exists again and the backoff starts over.
   */
  noteCapacityUsable(projectId: string): void {
    this.capacityBackoffSteps.delete(projectId);
  }

  /** zeenha fork: stop all capacity retry timers (daemon shutdown, app quit, tests). */
  dispose(): void {
    for (const block of this.capacityBlocks.values()) clearTimeout(block.timer);
    this.capacityBlocks.clear();
    this.capacityBackoffSteps.clear();
  }

  private activeCapacityBlock(projectId: string): CapacityBlock | undefined {
    const block = this.capacityBlocks.get(projectId);
    if (block && block.until > Date.now()) return block;
    return undefined;
  }

  private blockCapacity(projectId: string, reason: string, retryAt?: number): void {
    const now = Date.now();
    const known = retryAt !== undefined && Number.isFinite(retryAt) && retryAt > now;
    let delay: number;
    if (known) {
      delay = retryAt - now;
    } else {
      const step = this.capacityBackoffSteps.get(projectId) ?? 0;
      delay = Math.min(CAPACITY_BACKOFF_BASE_MS * 2 ** step, CAPACITY_BACKOFF_MAX_MS);
      this.capacityBackoffSteps.set(projectId, step + 1);
    }
    delay = Math.min(delay, MAX_TIMER_MS);
    const previous = this.capacityBlocks.get(projectId);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      if (this.capacityBlocks.get(projectId)?.timer !== timer) return;
      this.capacityBlocks.delete(projectId);
      void this.requestProcess(projectId);
    }, delay);
    timer.unref?.();
    this.capacityBlocks.set(projectId, { until: now + delay, reason, estimated: !known, timer });
    appLogPort.warn(
      `[Queue] Waiting for account capacity in project ${projectId} until ${new Date(now + delay).toISOString()}: ${reason}`
    );
  }

  private clearCapacityBlock(projectId: string): void {
    const block = this.capacityBlocks.get(projectId);
    if (!block) return;
    clearTimeout(block.timer);
    this.capacityBlocks.delete(projectId);
  }

  /** zeenha fork: true when promotion must wait for account capacity. Never throws. */
  private async isCapacityBlocked(projectId: string, task: Task): Promise<boolean> {
    if (this.activeCapacityBlock(projectId)) return true;
    const check = this.deps?.checkCapacity;
    if (!check) return false;
    let result: CapacityCheckResult;
    try {
      result = await check(projectId, task);
    } catch (error) {
      appLogPort.error(`[Queue] Capacity check failed for project ${projectId}:`, error);
      return false;
    }
    if (result.ok) {
      this.clearCapacityBlock(projectId);
      return false;
    }
    this.blockCapacity(projectId, result.reason, result.retryAt);
    return true;
  }

  private forgetPromoted(taskId: string, projectId?: string): void {
    const sets = projectId ? [this.promotedIds.get(projectId)] : [...this.promotedIds.values()];
    for (const set of sets) set?.delete(taskId);
  }

  getState(projectId: string): QueueState {
    const deps = this.requireDeps();
    const tasks = deps.getTasks(projectId);
    const promoted = this.promotedIds.get(projectId);
    const inProgressCount = this.countRunning(tasks, promoted);
    const queued = this.candidates(tasks, promoted, new Set());
    return {
      projectId,
      maxParallelTasks: this.getLimit(projectId),
      inProgressCount,
      queuedTaskIds: queued.map((t) => t.id),
      skippedTaskIds: [...(this.skipped.get(projectId) ?? [])],
      ...this.capacityState(projectId),
    };
  }

  private capacityState(projectId: string): Partial<QueueState> {
    const block = this.activeCapacityBlock(projectId);
    if (!block) return {};
    return {
      capacityBlockedUntil: block.until,
      capacityBlockedReason: block.reason,
      capacityRetryEstimated: block.estimated,
    };
  }

  /**
   * zeenha fork: getState plus the lock info, so a board that loads (or reloads)
   * while the daemon runs the queue can show who holds it and which tasks it runs.
   */
  getStateWithLock(projectId: string): QueueState {
    const state = this.getState(projectId);
    try {
      const gate = this.requireDeps().canProcess?.(projectId);
      if (gate && !gate.ok) return this.withLock(state, gate);
    } catch (error) {
      appLogPort.error(`[Queue] Lock check failed for project ${projectId}:`, error);
    }
    return state;
  }

  private withLock(state: QueueState, gate: { heldBy: string; runningTaskIds?: string[] }): QueueState {
    const locked: QueueState = { ...state, lockedBy: gate.heldBy };
    if (gate.runningTaskIds && gate.runningTaskIds.length > 0) locked.lockedTaskIds = [...gate.runningTaskIds];
    return locked;
  }

  private requireDeps(): TaskQueueDeps {
    if (!this.deps) throw new Error('TaskQueueManager is not configured');
    return this.deps;
  }

  private getLimit(projectId: string): number {
    const project = this.requireDeps().getProjects().find((p) => p.id === projectId);
    return project?.settings?.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TASKS;
  }

  /** Tasks counting toward capacity: in_progress, plus promoted ones whose file still reads 'queue'. */
  private countRunning(tasks: Task[], promoted?: Set<string>): number {
    return tasks.filter(
      (t) => isActive(t) && (t.status === 'in_progress' || (t.status === 'queue' && promoted?.has(t.id)))
    ).length;
  }

  private candidates(tasks: Task[], promoted: Set<string> | undefined, attempted: Set<string>): Task[] {
    return tasks
      .filter((t) => t.status === 'queue' && isActive(t) && !attempted.has(t.id) && !promoted?.has(t.id))
      .sort((a, b) => createdAtMs(a) - createdAtMs(b));
  }

  private schedule(projectId: string): Promise<void> {
    if (this.running.has(projectId)) {
      // A pass is in flight: make sure one more pass runs after it so no change is lost.
      this.rerun.add(projectId);
      return this.chains.get(projectId) ?? Promise.resolve();
    }
    this.running.add(projectId);
    const chain = (async () => {
      try {
        do {
          this.rerun.delete(projectId);
          await this.processProject(projectId);
        } while (this.rerun.has(projectId));
      } finally {
        this.running.delete(projectId);
        this.chains.delete(projectId);
      }
    })();
    this.chains.set(projectId, chain);
    return chain;
  }

  private async processProject(projectId: string): Promise<void> {
    const deps = this.requireDeps();
    try {
      const gate = deps.canProcess?.(projectId);
      if (gate && !gate.ok) {
        deps.emitState?.(projectId, this.withLock(this.getState(projectId), gate));
        return;
      }
    } catch (error) {
      appLogPort.error(`[Queue] Lock check failed for project ${projectId}:`, error);
    }
    try {
      const attempted = new Set<string>();
      let consecutiveFailures = 0;
      const limit = this.getLimit(projectId);

      while (true) {
        const tasks = deps.getTasks(projectId);
        let promoted = this.promotedIds.get(projectId);
        if (promoted) {
          // Prune promoted ids whose status moved on (anything other than queue/in_progress)
          for (const id of [...promoted]) {
            const t = tasks.find((x) => x.id === id);
            if (!t || (t.status !== 'queue' && t.status !== 'in_progress')) promoted.delete(id);
          }
        }
        promoted = this.promotedIds.get(projectId);

        const inProgressCount = this.countRunning(tasks, promoted);
        // zeenha fork: tasks with unfinished dependencies are held, not failed. They
        // stay out of `attempted` and are promoted once a later pass finds them ready.
        // zeenha fork: scheduled tasks are started by schedule-service, which applies
        // its own limit; promoting them here too could start the same task twice.
        const queued = this.candidates(tasks, promoted, attempted).filter(
          (t) =>
            !t.metadata?.scheduleId &&
            evaluateTaskDependencies(t, tasks).state === 'ready' &&
            // zeenha fork: a task held until an overlapping task finishes waits too
            !isHoldActive(t, tasks)
        );
        if (inProgressCount >= limit || queued.length === 0) break;

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          appLogPort.warn(`[Queue] Stopping queue processing after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
          break;
        }

        const next = queued[0];
        // zeenha fork: no account can take the task. Stop this pass without marking
        // the task as failed; a timer runs the next pass when capacity should return.
        if (await this.isCapacityBlocked(projectId, next)) break;

        let result: PromoteResult;
        try {
          result = await deps.promote(next.id, projectId);
        } catch (error) {
          result = { success: false, error: error instanceof Error ? error.message : String(error) };
        }

        if (result.success) {
          consecutiveFailures = 0;
          const set = this.promotedIds.get(projectId) ?? new Set<string>();
          set.add(next.id);
          this.promotedIds.set(projectId, set);
        } else {
          appLogPort.error(`[Queue] Failed to promote task ${next.id} to In Progress: ${result.error ?? 'unknown error'}`);
          attempted.add(next.id);
          consecutiveFailures++;
        }
      }

      this.skipped.set(projectId, [...attempted]);
      if (attempted.size > 0) {
        appLogPort.warn(`[Queue] Skipped ${attempted.size} task(s) that failed to promote`);
      }
    } catch (error) {
      appLogPort.error(`[Queue] Queue pass failed for project ${projectId}:`, error);
    }
    try {
      deps.emitState?.(projectId, this.getState(projectId));
    } catch (error) {
      appLogPort.error(`[Queue] Failed to emit queue state for project ${projectId}:`, error);
    }
  }
}

export const taskQueueManager = new TaskQueueManager();
