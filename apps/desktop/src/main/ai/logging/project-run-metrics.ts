/**
 * zeenha fork: project-wide delivery and token metrics, aggregated from every
 * task's `run_metrics.json` and `delivery_timing.json`.
 * Update the user guide at guides/delivery-metrics.md when these rules change.
 *
 * Reading is async, bounded and yields to the event loop between batches so a
 * project with hundreds of specs never starves the main process. The
 * aggregation itself is pure. A missing or corrupt file never throws: it is
 * counted so the view can say how many tasks were left out.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DeliveryTimingResult,
  DeliveryTimingStats,
  ProjectDeliveryTiming,
  ProjectRunMetrics,
  ProjectRunMetricsGroup,
  ProjectRunMetricsTrendPoint,
  SessionMetricsEntry,
} from '../../../shared/types/run-metrics';
import {
  deriveDeliveryTiming,
  type DeliveryTimingState,
  percentileNearestRank,
  readDeliveryTimingState,
} from './delivery-timing';
import { emptyTokens, num, RUN_METRICS_FILE } from './run-metrics';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILED_LIST_CAP = 50;
const DEFAULT_CONCURRENCY = 8;

export type RunMetricsState =
  | { state: 'ok'; sessions: SessionMetricsEntry[] }
  | { state: 'missing' }
  | { state: 'corrupt' };

/** Distinguishes a missing file from a corrupt one, which `readRunMetrics` cannot. */
export async function readRunMetricsState(specDir: string): Promise<RunMetricsState> {
  let raw: string;
  try {
    raw = await readFile(join(specDir, RUN_METRICS_FILE), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'corrupt' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'corrupt' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'corrupt' };
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return { state: 'corrupt' };
  const valid = sessions.filter(
    (s): s is SessionMetricsEntry => s !== null && typeof s === 'object' && !Array.isArray(s)
  );
  return valid.length === 0 ? { state: 'missing' } : { state: 'ok', sessions: valid };
}

export interface ProjectTaskRef {
  specId: string;
  status: string;
  reviewReason?: string;
  title?: string;
  updatedAt: Date | string | number;
}

export interface ProjectRunMetricInput extends ProjectTaskRef {
  metrics: RunMetricsState;
  timing?: DeliveryTimingState;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Reads every task's metrics, `concurrency` at a time, yielding between batches. */
export async function loadProjectRunMetricInputs(
  tasks: ProjectTaskRef[],
  specsDir: string,
  { concurrency = DEFAULT_CONCURRENCY }: { concurrency?: number } = {}
): Promise<ProjectRunMetricInput[]> {
  const size = Math.max(1, Math.floor(concurrency) || DEFAULT_CONCURRENCY);
  const inputs: ProjectRunMetricInput[] = [];
  for (let i = 0; i < tasks.length; i += size) {
    const batch = tasks.slice(i, i + size);
    const results = await Promise.all(
      batch.map(async (task) => {
        let metrics: RunMetricsState;
        try {
          metrics = await readRunMetricsState(join(specsDir, task.specId));
        } catch {
          metrics = { state: 'corrupt' };
        }
        let timing: DeliveryTimingState;
        try {
          timing = await readDeliveryTimingState(join(specsDir, task.specId));
        } catch {
          timing = { state: 'corrupt' };
        }
        return { ...task, metrics, timing };
      })
    );
    inputs.push(...results);
    await tick();
  }
  return inputs;
}

const isCompleted = (status: string): boolean => status === 'done' || status === 'pr_created';
const isNeverStarted = (status: string): boolean => status === 'backlog' || status === 'queue';

function startedAtMs(entry: SessionMetricsEntry): number {
  const ms = typeof entry.startedAt === 'string' ? Date.parse(entry.startedAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function toMs(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function addToGroup(
  groups: Map<string, ProjectRunMetricsGroup>,
  taskSeen: Map<string, Set<string>>,
  key: string,
  specId: string,
  entry: SessionMetricsEntry
): void {
  const group =
    groups.get(key) ?? { key, tasks: 0, sessions: 0, durationMs: 0, tokens: emptyTokens(), totalTokens: 0 };
  const seen = taskSeen.get(key) ?? new Set<string>();
  if (!seen.has(specId)) {
    seen.add(specId);
    group.tasks += 1;
  }
  taskSeen.set(key, seen);
  const input = num(entry.tokens?.input);
  const output = num(entry.tokens?.output);
  group.sessions += 1;
  group.durationMs += num(entry.durationMs);
  group.tokens.input += input;
  group.tokens.output += output;
  group.tokens.cacheRead += num(entry.tokens?.cacheRead);
  group.tokens.cacheCreation += num(entry.tokens?.cacheCreation);
  group.totalTokens += input + output;
  groups.set(key, group);
}

const keyOf = (value: unknown): string => (typeof value === 'string' && value.length > 0 ? value : 'unknown');

const byTotalTokens = (a: ProjectRunMetricsGroup, b: ProjectRunMetricsGroup) =>
  b.totalTokens - a.totalTokens || a.key.localeCompare(b.key);

type DeliveryTimingSample = Extract<DeliveryTimingResult, { state: 'complete' }>;

function timingStats(values: number[]): DeliveryTimingStats {
  values.sort((a, b) => a - b);
  return {
    samples: values.length,
    medianMs: percentileNearestRank(values, 0.5),
    p90Ms: percentileNearestRank(values, 0.9),
  };
}

function summarizeDeliveryTiming(
  samples: DeliveryTimingSample[],
  unknown: ProjectDeliveryTiming['unknown']
): ProjectDeliveryTiming {
  const measuredTasks = samples.length;
  const eligibleTasks = measuredTasks + unknown.missing + unknown.corrupt + unknown.incomplete;
  return {
    eligibleTasks,
    measuredTasks,
    coverage: eligibleTasks > 0 ? measuredTasks / eligibleTasks : null,
    unknown,
    queueToReviewReady: timingStats(samples.map((sample) => sample.totalMs)),
    segments: {
      queuedMs: timingStats(samples.map((sample) => sample.segments.queuedMs)),
      activeMs: timingStats(samples.map((sample) => sample.segments.activeMs)),
      credentialPauseMs: timingStats(samples.map((sample) => sample.segments.credentialPauseMs)),
      budgetPauseMs: timingStats(samples.map((sample) => sample.segments.budgetPauseMs)),
      otherMs: timingStats(samples.map((sample) => sample.segments.otherMs)),
    },
  };
}

/** Pure aggregate. Total tokens = input + output; cacheRead is already inside input. */
export function buildProjectRunMetrics(
  inputs: ProjectRunMetricInput[],
  { periodDays, now = new Date() }: { periodDays: number | null; now?: Date }
): ProjectRunMetrics {
  const cutoff = periodDays === null ? Number.NEGATIVE_INFINITY : now.getTime() - periodDays * DAY_MS;

  const phases = new Map<string, ProjectRunMetricsGroup>();
  const models = new Map<string, ProjectRunMetricsGroup>();
  const phaseTasks = new Map<string, Set<string>>();
  const modelTasks = new Map<string, Set<string>>();
  const trend = new Map<string, { completedTasks: number; totalTokens: number }>();
  const failed: Array<{ specId: string; title?: string }> = [];

  const timingSamples: DeliveryTimingSample[] = [];
  const unknownTiming: ProjectDeliveryTiming['unknown'] = { missing: 0, corrupt: 0, incomplete: 0 };

  const result: Omit<ProjectRunMetrics, 'deliveryTiming'> = {
    periodDays,
    generatedAt: now.toISOString(),
    taskCount: 0,
    included: 0,
    excluded: { missing: 0, corrupt: 0 },
    completedTasks: 0,
    failedBeforeWork: { count: 0 },
    totals: { sessions: 0, durationMs: 0, tokens: emptyTokens(), totalTokens: 0 },
    perCompletedTask: null,
    qa: { tasksWithQa: 0, totalIterations: 0, averageIterations: null },
    byPhase: [],
    byModel: [],
    trend: [],
  };

  let completedTokens = 0;
  let completedDuration = 0;

  for (const input of inputs) {
    const { metrics, status } = input;
    const sessions = metrics.state === 'ok' ? metrics.sessions : [];
    const newest = sessions.reduce((max, s) => Math.max(max, startedAtMs(s)), 0);
    const taskTime = newest > 0 ? newest : toMs(input.updatedAt);

    // A known review-ready date takes precedence over the legacy taskTime cutoff.
    const timing = input.timing ?? { state: 'missing' };
    const delivery = timing.state === 'ok' ? deriveDeliveryTiming(timing.events) : timing;
    if (delivery.state === 'complete') {
      if (Date.parse(delivery.reviewReadyAt) >= cutoff) timingSamples.push(delivery);
    } else if (
      taskTime >= cutoff &&
      (isCompleted(status) || (status === 'human_review' && input.reviewReason === 'completed'))
    ) {
      const reason = delivery.state === 'missing' || delivery.state === 'corrupt' ? delivery.state : 'incomplete';
      unknownTiming[reason] += 1;
    }

    if (taskTime < cutoff) continue;

    // "Failed before any work" counts every error task in the period, even with recorded sessions.
    // Those sessions' tokens count toward totals, not per-completed-task averages.
    const failedTask = status === 'error';
    if (metrics.state === 'missing' && (failedTask || isNeverStarted(status))) {
      // Expected to have no metrics: not an exclusion.
      if (failedTask) {
        result.taskCount += 1;
        result.failedBeforeWork.count += 1;
        if (failed.length < FAILED_LIST_CAP) failed.push({ specId: input.specId, title: input.title });
      }
      continue;
    }

    result.taskCount += 1;
    if (failedTask) {
      result.failedBeforeWork.count += 1;
      if (failed.length < FAILED_LIST_CAP) failed.push({ specId: input.specId, title: input.title });
    }

    if (metrics.state !== 'ok') {
      result.excluded[metrics.state] += 1;
      continue;
    }

    result.included += 1;
    let taskTokens = 0;
    let taskDuration = 0;
    let qaSessions = 0;
    for (const entry of sessions) {
      const input_ = num(entry.tokens?.input);
      const output = num(entry.tokens?.output);
      const duration = num(entry.durationMs);
      result.totals.sessions += 1;
      result.totals.durationMs += duration;
      result.totals.tokens.input += input_;
      result.totals.tokens.output += output;
      result.totals.tokens.cacheRead += num(entry.tokens?.cacheRead);
      result.totals.tokens.cacheCreation += num(entry.tokens?.cacheCreation);
      result.totals.totalTokens += input_ + output;
      taskTokens += input_ + output;
      taskDuration += duration;
      if (entry.agentType === 'qa_reviewer') qaSessions += 1;
      addToGroup(phases, phaseTasks, keyOf(entry.phase), input.specId, entry);
      addToGroup(models, modelTasks, keyOf(entry.model), input.specId, entry);
    }

    if (qaSessions > 0) {
      result.qa.tasksWithQa += 1;
      result.qa.totalIterations += qaSessions;
    }

    if (isCompleted(status)) {
      result.completedTasks += 1;
      completedTokens += taskTokens;
      completedDuration += taskDuration;
      const date = new Date(taskTime).toISOString().slice(0, 10);
      const point = trend.get(date) ?? { completedTasks: 0, totalTokens: 0 };
      point.completedTasks += 1;
      point.totalTokens += taskTokens;
      trend.set(date, point);
    }
  }

  if (result.completedTasks > 0) {
    result.perCompletedTask = {
      totalTokens: completedTokens / result.completedTasks,
      durationMs: completedDuration / result.completedTasks,
    };
  }
  if (result.qa.tasksWithQa > 0) {
    result.qa.averageIterations = result.qa.totalIterations / result.qa.tasksWithQa;
  }
  if (result.failedBeforeWork.count > 0) result.failedBeforeWork.tasks = failed;

  result.byPhase = [...phases.values()].sort(byTotalTokens);
  result.byModel = [...models.values()].sort(byTotalTokens);
  result.trend = [...trend.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([date, point]): ProjectRunMetricsTrendPoint => ({
        date,
        completedTasks: point.completedTasks,
        totalTokens: point.totalTokens,
        tokensPerCompletedTask: point.completedTasks > 0 ? point.totalTokens / point.completedTasks : null,
      })
    );
  return { ...result, deliveryTiming: summarizeDeliveryTiming(timingSamples, unknownTiming) };
}
