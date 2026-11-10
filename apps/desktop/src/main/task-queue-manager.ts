import type { Project, Task, TaskStatus, TaskQueueState } from '../shared/types';
import { DEFAULT_MAX_PARALLEL_TASKS } from '../shared/constants/queue';
import { evaluateTaskDependencies } from '../shared/utils/task-dependencies';
import { isHoldActive } from '../shared/utils/file-overlap';
import { appLog } from './app-logger';

/** Safety limit that stops a pass when promotions keep failing */
const MAX_CONSECUTIVE_FAILURES = 10;

export type QueueState = TaskQueueState;

export interface PromoteResult {
  success: boolean;
  error?: string;
}

export interface TaskQueueDeps {
  getProjects: () => Project[];
  getTasks: (projectId: string) => Task[];
  promote: (taskId: string, projectId: string) => Promise<PromoteResult>;
  emitState?: (projectId: string, state: QueueState) => void;
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

  /** Called on every task status change; a task leaving in_progress frees a slot. */
  async onTaskStatusChanged(taskId: string, status: TaskStatus, projectId?: string): Promise<void> {
    if (status === 'in_progress') return;
    // Any other status event proves the task has left the running state (including a drag back to
    // 'queue'), so the promoted marker must not keep counting it toward capacity.
    this.forgetPromoted(taskId, projectId);
    await this.requestProcess(projectId);
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
    };
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
        const queued = this.candidates(tasks, promoted, attempted).filter(
          // zeenha fork: a task held until an overlapping task finishes waits too
          (t) => evaluateTaskDependencies(t, tasks).state === 'ready' && !isHoldActive(t, tasks)
        );
        if (inProgressCount >= limit || queued.length === 0) break;

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          appLog.warn(`[Queue] Stopping queue processing after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
          break;
        }

        const next = queued[0];
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
          appLog.error(`[Queue] Failed to promote task ${next.id} to In Progress: ${result.error ?? 'unknown error'}`);
          attempted.add(next.id);
          consecutiveFailures++;
        }
      }

      this.skipped.set(projectId, [...attempted]);
      if (attempted.size > 0) {
        appLog.warn(`[Queue] Skipped ${attempted.size} task(s) that failed to promote`);
      }
    } catch (error) {
      appLog.error(`[Queue] Queue pass failed for project ${projectId}:`, error);
    }
    try {
      deps.emitState?.(projectId, this.getState(projectId));
    } catch (error) {
      appLog.error(`[Queue] Failed to emit queue state for project ${projectId}:`, error);
    }
  }
}

export const taskQueueManager = new TaskQueueManager();
