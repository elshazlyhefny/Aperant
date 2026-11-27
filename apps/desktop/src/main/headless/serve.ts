/**
 * zeenha fork: the headless queue daemon (`cli.js serve`).
 *
 * Runs TaskQueueManager and the schedule service without Electron. Queued and
 * scheduled tasks are started with the headless runner, their outcomes are
 * persisted in the plan files and reported through the outcome webhook and, when
 * configured, written back to the source issue (GitHub, GitLab, Linear, Jira). The
 * daemon owns the project's queue lock, so the desktop app and the daemon never
 * run the same queue at once. SIGTERM/SIGINT stop the runs, put the tasks back to
 * 'queue' with stuck subtasks reset (resumable) and release the lock.
 *
 * `stop-spec` drops a request file in .auto-claude/.locks/; the daemon polls it on
 * its safety timer and stops that one run, leaving the task in human_review
 * ('stopped') or, with requeue, back in the queue. Other runs are not touched.
 *
 * Do not import electron, project-store, app-logger or settings-utils here.
 */

import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

import { getSpecsDir } from '../../shared/constants';
import type { Project, ReviewReason, Task, TaskStatus } from '../../shared/types';
import type { WebhookSettings } from '../../shared/types/settings';
import type { RecurringSchedule } from '../../shared/types/schedule';
import type { WorkerBridgeCoreOptions } from '../ai/agent/worker-bridge-core';
import { createScheduleFileStore } from '../schedule-file-store';
import { createScheduleService, readTaskTokensFromDisk } from '../schedule-service';
import { TaskQueueManager } from '../task-queue-manager';
import { writeFileAtomicSync } from '../utils/atomic-file';
import { acquireProjectQueueLock, formatLockHolder } from '../utils/project-queue-lock';
import type { QueueLockOptions } from '../utils/project-queue-lock';
import { getServeRunningPath, readServeRunningTaskIds } from '../utils/serve-running-file';
import { findAllSpecPaths } from '../utils/spec-path-helpers';
import { dispatchTaskOutcomeWebhookWith, mapOutcomeToWebhookEvent } from '../webhook-core';
import { loadHeadlessConfig } from './config';
import type { HeadlessConfig } from './config';
import { EXIT_ERROR } from './outcome';
import { runHeadlessTaskDetailed } from './run-task';
import { consumeStopRequests } from './stop-request';
import type { HeadlessBridge, HeadlessRunResult } from './run-task';
import {
  createScheduledTaskSpec,
  listHeadlessTasks,
  resetStuckSubtasks,
  setTaskStatus,
} from './task-store';
import type { HeadlessProject, TaskStatusTiming } from './task-store';
import { AUTO_BUILD_PATH, findGitRoot } from './shared';
import { resolveServeWebhookSettings } from './webhook';
import { reportOutcomeToSource, resolveHeadlessWritebackSettings } from './writeback';
import type { HeadlessWritebackSettings } from './writeback';

export const EXIT_LOCKED = 3;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const SAFETY_PROCESS_INTERVAL_MS = 30_000;

export interface ServeOptions {
  projectPath: string;
  projectId?: string;
  configPath?: string;
  schedulesPath?: string;
  baseBranch?: string;
  noPush?: boolean;
  json?: boolean;
  verbose?: boolean;
  workerPath?: string;
  shutdownTimeoutMs?: number;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Already-loaded config; used instead of reading configPath. */
  config?: HeadlessConfig;
  // test seams
  createBridge?: (options: WorkerBridgeCoreOptions) => HeadlessBridge;
  now?: () => number;
  /** Also runs the schedule tick at this interval, and once at start. */
  tickIntervalMs?: number;
  /** Registers the signal handler; returns the uninstall function. Defaults to process SIGTERM/SIGINT. */
  installSignalHandlers?: (onSignal: (signal: string) => void) => () => void;
  dispatchWebhook?: typeof dispatchTaskOutcomeWebhookWith;
  dispatchWriteback?: typeof reportOutcomeToSource;
  lockOptions?: QueueLockOptions;
  /** Interval of the safety queue pass and stop-request poll. Defaults to 30s. */
  safetyIntervalMs?: number;
}

type StopReason = 'budget' | 'shutdown' | 'stop' | 'stop-requeue';

interface ActiveRun {
  controller: AbortController;
  stopReason?: StopReason;
  title: string;
  done: Promise<void>;
}

function defaultInstallSignals(onSignal: (signal: string) => void): () => void {
  const onTerm = () => onSignal('SIGTERM');
  const onInt = () => onSignal('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  return () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
}

function prefixLines(prefix: string, sink: (text: string) => void): (text: string) => void {
  return (text) => {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) sink(`${prefix}${line}\n`);
  };
}

export async function runServe(options: ServeOptions): Promise<number> {
  const rawOut = options.out ?? ((t: string) => void process.stdout.write(t));
  const rawErr = options.err ?? ((t: string) => void process.stderr.write(t));
  const now = options.now ?? Date.now;
  const log = (message: string) => rawOut(`${new Date(now()).toISOString()} ${message}\n`);

  let projectPath: string;
  let config: HeadlessConfig;
  let webhookSettings: WebhookSettings;
  let writebackSettings: HeadlessWritebackSettings;
  try {
    projectPath = findGitRoot(path.resolve(options.projectPath));
    config = options.config ?? loadHeadlessConfig(options.configPath);
    webhookSettings = resolveServeWebhookSettings(config);
    writebackSettings = resolveHeadlessWritebackSettings(config);
  } catch (error) {
    rawErr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }

  const realProjectPath = realpathSync(projectPath);
  const projectId = options.projectId ?? `headless:${realProjectPath}`;
  const project: Project = {
    id: projectId,
    name: path.basename(realProjectPath),
    path: projectPath,
    autoBuildPath: AUTO_BUILD_PATH,
    settings: { maxParallelTasks: config.project?.maxParallelTasks } as Project['settings'],
    createdAt: new Date(now()),
    updatedAt: new Date(now()),
  };
  const headlessProject: HeadlessProject = { id: project.id, path: project.path, autoBuildPath: AUTO_BUILD_PATH };
  const limit = (): number => project.settings.maxParallelTasks ?? 3;
  const specsBaseDir = getSpecsDir(AUTO_BUILD_PATH);

  // (2) lock
  const acquired = acquireProjectQueueLock(projectPath, 'daemon', { now, ...options.lockOptions });
  if (!acquired.ok) {
    rawErr(`Cannot start: project queue is already run by ${formatLockHolder(acquired.holder)}\n`);
    return EXIT_LOCKED;
  }
  const lock = acquired.lock;
  lock.startHeartbeat();

  const runningFile = getServeRunningPath(projectPath);
  const runs = new Map<string, ActiveRun>();
  let stopping = false;

  const writeRunningFile = () => {
    try {
      mkdirSync(path.dirname(runningFile), { recursive: true });
      writeFileAtomicSync(runningFile, JSON.stringify({ taskIds: [...runs.keys()] }));
    } catch {
      // Best effort: only used for crash recovery
    }
  };

  /** Stuck subtasks back to pending on every copy of the spec's plan. */
  const resetPlans = async (specId: string) => {
    for (const specPath of findAllSpecPaths(projectPath, specsBaseDir, specId, '[headless-serve]')) {
      const planPath = path.join(specPath, 'implementation_plan.json');
      if (existsSync(planPath)) await resetStuckSubtasks(planPath);
    }
  };
  const requeue = async (specId: string, timing?: TaskStatusTiming) => {
    try {
      await resetPlans(specId);
      await setTaskStatus(headlessProject, specId, 'queue', undefined, timing);
    } catch (error) {
      log(`Could not requeue ${specId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // (3) startup recovery
  for (const taskId of readServeRunningTaskIds(projectPath)) {
    const task = listHeadlessTasks(headlessProject).find((t) => t.id === taskId);
    if (task?.status === 'in_progress') {
      log(`Recovering ${taskId} left running by a previous daemon`);
      // zeenha fork: the end of the crashed daemon's active segment is unknown.
      await requeue(taskId, { interrupted: true });
    }
  }
  rmSync(runningFile, { force: true });

  // A request left by a previous daemon must not be applied to a later run
  const staleRequests = consumeStopRequests(projectPath, log);
  if (staleRequests.length > 0) {
    log(`Discarded ${staleRequests.length} stale stop request(s)`);
  }

  const dispatchWebhook = options.dispatchWebhook ?? dispatchTaskOutcomeWebhookWith;
  const dispatchWriteback = options.dispatchWriteback ?? reportOutcomeToSource;

  // (4) queue and schedules
  const getTasks = (): Task[] => listHeadlessTasks(headlessProject);
  let mutex: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutex.then(fn, fn);
    mutex = next.catch(() => undefined);
    return next;
  };

  let queue: TaskQueueManager;
  let scheduleService: ReturnType<typeof createScheduleService>;

  const settle = async (taskId: string, run: ActiveRun, result: HeadlessRunResult | undefined, failure?: string) => {
    let status: TaskStatus = 'error';
    let reviewReason: ReviewReason | undefined;
    let interrupted = false;
    let reason: string | undefined = failure;
    const stoppedByRequest = run.stopReason === 'stop' || run.stopReason === 'stop-requeue';

    if (stoppedByRequest) {
      interrupted = true;
    } else if (result?.aborted && run.stopReason !== 'budget') {
      interrupted = true;
    } else if (result?.aborted && run.stopReason === 'budget') {
      reason = 'token budget reached';
    } else if (result?.outcome) {
      reason = result.outcome.reason;
      if (result.outcome.accountPaused) {
        status = 'human_review';
        reviewReason = 'account_required';
      } else if (result.outcome.kind === 'success') {
        status = 'human_review';
        reviewReason = 'completed';
      } else if (result.outcome.kind === 'qa_failed') {
        status = 'human_review';
        reviewReason = 'qa_rejected';
      }
    }

    try {
      if (run.stopReason === 'stop') {
        await resetPlans(taskId);
        await setTaskStatus(headlessProject, taskId, 'human_review', 'stopped');
        log(`${taskId} stopped by request`);
      } else if (run.stopReason === 'stop-requeue') {
        await requeue(taskId);
        log(`${taskId} stopped by request, back in the queue`);
      } else if (interrupted) {
        await requeue(taskId);
        log(`${taskId} interrupted, back in the queue`);
      } else {
        // zeenha fork: keep the daemon's error status but measure it as a budget pause.
        const timing: TaskStatusTiming | undefined = run.stopReason === 'budget' ? { pause: 'budget' } : undefined;
        await setTaskStatus(headlessProject, taskId, status, reviewReason, timing);
        log(`${taskId} finished: ${status}${reviewReason ? ` (${reviewReason})` : ''}${reason ? ` - ${reason}` : ''}`);
      }
    } catch (error) {
      log(`Could not save the status of ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    runs.delete(taskId);
    writeRunningFile();

    if (!interrupted) {
      try {
        dispatchWebhook(webhookSettings, {
          status,
          reviewReason,
          projectName: project.name,
          taskTitle: run.title,
        });
      } catch (error) {
        log(`Webhook for ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // zeenha fork: an account pause is resumable and goes to the webhook only.
      // It is never written back to the issue (not even as failed): each paused
      // retry would post another public comment.
      const writebackEvent = mapOutcomeToWebhookEvent(status, reviewReason) ?? 'failed';
      if (writebackEvent !== 'account_required') {
        try {
          // Awaited, so shutdown (which waits on run.done) does not drop a pending write.
          await dispatchWriteback({
            settings: writebackSettings,
            project,
            specDirs: findAllSpecPaths(projectPath, specsBaseDir, taskId, '[headless-serve]'),
            event: writebackEvent,
            title: run.title,
            prUrl: result?.outcome?.prUrl,
            warn: log,
          });
        } catch (error) {
          log(`Write-back for ${taskId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (!stopping) {
      try {
        const newStatus: TaskStatus =
          run.stopReason === 'stop' ? 'human_review' : interrupted ? 'queue' : status;
        await queue.onTaskStatusChanged(taskId, newStatus, projectId);
      } catch (error) {
        log(`Queue update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      scheduleService.onAgentExit(taskId);
    }
  };

  const startTask = (taskId: string): Promise<void> =>
    exclusive(async () => {
      if (stopping) throw new Error('daemon is shutting down');
      if (runs.has(taskId)) return;
      const tasks = getTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      const active = tasks.filter(
        (t) => t.id !== taskId && !t.metadata?.archivedAt && (t.status === 'in_progress' || runs.has(t.id))
      ).length;
      if (active >= limit()) throw new Error(`parallel limit reached (${limit()})`);

      await setTaskStatus(headlessProject, taskId, 'in_progress');
      const controller = new AbortController();
      const run = { controller, title: task.title } as ActiveRun;
      runs.set(taskId, run);
      writeRunningFile();
      log(`Starting ${taskId}`);

      run.done = (async () => {
        let result: HeadlessRunResult | undefined;
        let failure: string | undefined;
        try {
          result = await runHeadlessTaskDetailed({
            projectPath,
            spec: taskId,
            config,
            signal: controller.signal,
            handleProcessSignals: false,
            // The daemon sends its own webhook in settle(), once the final status is known.
            sendWebhook: false,
            // Same for the source write-back.
            sendWriteback: false,
            baseBranch: options.baseBranch,
            noPush: options.noPush,
            json: options.json,
            verbose: options.verbose,
            workerPath: options.workerPath,
            createBridge: options.createBridge,
            out: prefixLines(`[${taskId}] `, rawOut),
            err: prefixLines(`[${taskId}] `, rawErr),
          });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        await settle(taskId, run, result, failure);
      })();
    });

  queue = new TaskQueueManager({
    getProjects: () => [project],
    getTasks: () => getTasks(),
    promote: async (taskId) => {
      try {
        await startTask(taskId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  const scheduleStore = createScheduleFileStore(
    options.schedulesPath ?? path.join(projectPath, AUTO_BUILD_PATH, 'schedules.json')
  );
  const originalProjectIds = new Map<string, string>();
  const listSchedules = (): RecurringSchedule[] =>
    scheduleStore
      .listSchedules()
      .filter((s) => !options.projectId || s.projectId === options.projectId)
      .map((s) => {
        originalProjectIds.set(s.id, s.projectId);
        return { ...s, projectId };
      });

  scheduleService = createScheduleService({
    now,
    listSchedules,
    saveSchedule: (schedule) => {
      scheduleStore.saveSchedule({ ...schedule, projectId: originalProjectIds.get(schedule.id) ?? schedule.projectId });
    },
    getProject: (id) => (id === projectId ? project : undefined),
    listTasks: () => getTasks(),
    createTask: async (_projectId, template, scheduleId, scheduledFor) => {
      const task = await createScheduledTaskSpec(headlessProject, template, scheduleId, scheduledFor);
      await setTaskStatus(headlessProject, task.id, 'queue');
      return task.id;
    },
    startTask,
    isRunning: (taskId) => runs.has(taskId),
    readTaskTokens: (_projectId, specId) => readTaskTokensFromDisk(project, specId),
    stopTask: (taskId) => {
      const run = runs.get(taskId);
      if (!run) return;
      run.stopReason = 'budget';
      run.controller.abort('token budget reached');
    },
    notifyChanged: (id) => log(`Schedules changed for ${id}`),
  });

  // (7) start
  log(`Serving ${project.name} (${projectPath}), up to ${limit()} parallel task(s)`);
  await queue.requestProcess();
  scheduleService.start();
  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (options.tickIntervalMs !== undefined) {
    void scheduleService.tick();
    const tickTimer = setInterval(() => void scheduleService.tick(), options.tickIntervalMs);
    tickTimer.unref?.();
    timers.push(tickTimer);
  }
  const processStopRequests = () => {
    for (const request of consumeStopRequests(projectPath, log)) {
      const run = runs.get(request.specId);
      if (!run) {
        log(`Stop requested for ${request.specId}, but it is not running`);
        continue;
      }
      run.stopReason = request.requeue ? 'stop-requeue' : 'stop';
      log(`Stopping ${request.specId}`);
      run.controller.abort('stop requested');
    }
  };
  const safetyTimer = setInterval(() => {
    if (stopping) return;
    void queue.requestProcess();
    processStopRequests();
  }, options.safetyIntervalMs ?? SAFETY_PROCESS_INTERVAL_MS);
  // Not unref'd: this timer is what keeps the daemon alive while it is idle
  timers.push(safetyTimer);

  // (8) shutdown
  return new Promise<number>((resolve) => {
    let signalCount = 0;
    let finished = false;

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      uninstall();
      lock.release();
      rmSync(runningFile, { force: true });
      resolve(code);
    };

    const shutdown = async () => {
      log('Shutting down');
      scheduleService.stop();
      for (const timer of timers) clearInterval(timer);
      stopping = true;
      for (const run of runs.values()) {
        run.stopReason ??= 'shutdown';
        run.controller.abort('shutdown');
      }
      const pending = [...runs.values()].map((r) => r.done);
      const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((r) => {
          timeout = setTimeout(r, timeoutMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      for (const taskId of [...runs.keys()]) {
        log(`${taskId} did not stop in time, requeueing`);
        await requeue(taskId);
        runs.delete(taskId);
      }
      log('Stopped');
      finish(0);
    };

    const uninstall = (options.installSignalHandlers ?? defaultInstallSignals)((signal) => {
      signalCount++;
      if (signalCount === 1) {
        log(`Received ${signal}`);
        void shutdown();
      } else {
        log(`Received ${signal} again, forcing exit`);
        for (const run of runs.values()) run.controller.abort('shutdown');
        finish(1);
      }
    });
  });
}
