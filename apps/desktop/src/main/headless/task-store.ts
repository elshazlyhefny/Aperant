/**
 * zeenha fork: Electron-free task store for the headless daemon (`cli.js serve`).
 *
 * The desktop reads tasks through `ProjectStore` (project-store.ts), which imports
 * `electron`. The daemon uses its own filesystem adapter and shares persisted
 * field interpretation with ProjectStore through `../task-record-fields.ts`.
 *
 * Deliberate differences: no stale-status correction writes, no failed-run
 * classification, no JSON-error display markers, and different
 * executionProgress inference. A worktree copy of a spec wins over the main
 * copy because the agent writes the live plan there.
 *
 * The daemon can reuse parsed files with a daemon-scoped FileParseCache, validated
 * by mtime, size and file identity, and invalidated on its own writes. One-shot
 * CLI commands read uncached.
 *
 * Keep resetStuckSubtasks in sync with ipc-handlers/task/plan-file-utils.ts.
 * Do not import electron, project-store, app-logger or plan-file-utils here.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import type {
  ExecutionPhase,
  ImplementationPlan,
  ReviewReason,
  Task,
  TaskMetadata,
  TaskStatus
} from '../../shared/types';
import type { ScheduleTemplate } from '../../shared/types/schedule';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../shared/constants';
import { mapStatusToPlanStatus } from '../../shared/utils/plan-status';
import { normalizeTaskTokenBudget } from '../../shared/utils/token-budget';
import { recordDeliveryTimingEvent } from '../ai/logging/delivery-timing';
import { mapPersistedTaskFields, type ParsedSpecMarkdown, parseSpecMarkdown } from '../task-record-fields';
import { writeFileAtomicSync } from '../utils/atomic-file';
import { withFileLock } from '../utils/file-lock';
import { FileParseCache } from '../utils/file-parse-cache';
import { safeParseJson } from '../utils/json-repair';
import { allocateSpecDir } from '../utils/spec-number-lock';
import { findAllSpecPaths } from '../utils/spec-path-helpers';
import { getTaskWorktreeDir } from '../worktree-paths';

export interface HeadlessProject {
  id: string;
  path: string;
  autoBuildPath?: string;
}

const METADATA_FILE = 'task_metadata.json';

// zeenha fork: distinguish missing plans from unreadable or malformed plans
// without a separate existence check before reading.
function readJson<T>(file: string, cache?: FileParseCache, touched?: Set<string>): T | null | undefined {
  touched?.add(file);
  try {
    return cache ? cache.read(file, (raw) => safeParseJson<T>(raw)) : safeParseJson<T>(readFileSync(file, 'utf-8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
}

function inferPhase(planStatus: string | undefined): ExecutionPhase | undefined {
  switch (planStatus) {
    case 'planning':
      return 'planning';
    case 'in_progress':
    case 'coding':
      return 'coding';
    case 'review':
    case 'ai_review':
      return 'qa_review';
    case 'human_review':
    case 'completed':
    case 'done':
      return 'complete';
    default:
      return undefined;
  }
}

function loadTaskFromSpecDir(specPath: string, projectId: string, cache?: FileParseCache, touched?: Set<string>): Task {
  const name = path.basename(specPath);
  const planPath = path.join(specPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  const planRead = readJson<ImplementationPlan>(planPath, cache, touched);
  const plan = planRead ?? null;
  const hasJsonError = planRead === null && (cache !== undefined || existsSync(planPath));
  const requirements = readJson<unknown>(path.join(specPath, AUTO_BUILD_PATHS.REQUIREMENTS), cache, touched);
  const metadata = readJson<TaskMetadata>(path.join(specPath, METADATA_FILE), cache, touched) ?? undefined;

  let specMarkdown: ParsedSpecMarkdown | undefined;
  let specMarkdownLoaded = false;
  const getSpecMarkdown = (): ParsedSpecMarkdown | undefined => {
    if (!specMarkdownLoaded) {
      specMarkdownLoaded = true;
      try {
        specMarkdown = parseSpecMarkdown(readFileSync(path.join(specPath, AUTO_BUILD_PATHS.SPEC_FILE), 'utf-8'));
      } catch {
        // spec.md may be missing or unreadable; keep the persisted fallbacks.
      }
    }
    return specMarkdown;
  };
  const { reviewReason, ...fields } = mapPersistedTaskFields({
    specId: name,
    plan,
    planUnreadable: hasJsonError,
    requirements,
    getSpecMarkdown,
    now: Date.now()
  });

  const persistedPhase = (plan as { executionPhase?: string } | null)?.executionPhase as ExecutionPhase | undefined;
  const phase = persistedPhase ?? inferPhase(plan?.status);

  return {
    id: name,
    specId: name,
    projectId,
    ...fields,
    logs: [],
    // zeenha fork: callers can mutate task metadata, but not the cached copy.
    metadata: cache && metadata !== undefined ? structuredClone(metadata) : metadata,
    ...(reviewReason !== undefined && { reviewReason }),
    ...(phase && { executionProgress: { phase, phaseProgress: 50, overallProgress: 50 } }),
    specsPath: specPath
  };
}

function listSpecDirs(specsDir: string): string[] | undefined {
  if (!existsSync(specsDir)) return undefined;
  try {
    return readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(specsDir, d.name));
  } catch {
    return undefined;
  }
}

function scanHeadlessTasks(project: HeadlessProject, cache?: FileParseCache, scannedDirs?: Set<string>): Map<string, Task> {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const tasks = new Map<string, Task>();

  function scanSpecsDir(specsDir: string, worktree: boolean): void {
    const specPaths = listSpecDirs(specsDir);
    if (!specPaths) return;
    scannedDirs?.add(specsDir);
    const touched = cache ? new Set<string>() : undefined;
    for (const specPath of specPaths) {
      // A worktree spec only counts when the spec exists in main.
      if (worktree && !tasks.has(path.basename(specPath))) continue;
      const task = loadTaskFromSpecDir(specPath, project.id, cache, touched);
      tasks.set(task.id, task);
    }
    if (cache && touched) cache.retainOnly(specsDir, touched);
  }

  scanSpecsDir(path.join(project.path, specsBaseDir), false);

  const worktreesDir = getTaskWorktreeDir(project.path);
  if (existsSync(worktreesDir)) {
    try {
      for (const worktree of readdirSync(worktreesDir, { withFileTypes: true })) {
        if (!worktree.isDirectory()) continue;
        scanSpecsDir(path.join(worktreesDir, worktree.name, specsBaseDir), true);
      }
    } catch {
      // Unreadable worktrees directory: keep the main tasks
    }
  }

  return tasks;
}

/** Every task of a project: main specs plus worktree specs (worktree copy wins). */
export function listHeadlessTasks(project: HeadlessProject, cache?: FileParseCache): Task[] {
  return Array.from(scanHeadlessTasks(project, cache).values());
}

/** zeenha fork: rediscover specs on every daemon scan, reusing only unchanged file contents. */
export function createHeadlessTaskReader(project: HeadlessProject) {
  const cache = new FileParseCache();
  let previousDirs = new Set<string>();

  function snapshotById(): Map<string, Task> {
    const scannedDirs = new Set<string>();
    const tasks = scanHeadlessTasks(project, cache, scannedDirs);
    for (const dir of previousDirs) {
      if (!scannedDirs.has(dir)) cache.evictScope(dir);
    }
    previousDirs = scannedDirs;
    return tasks;
  }

  return {
    list: (): Task[] => Array.from(snapshotById().values()),
    snapshotById,
    cache,
    stats: cache.stats
  };
}

export interface TaskStatusTiming {
  pause?: 'budget' | 'credential';
  interrupted?: boolean;
}

/** Persist a status on the worktree and main copy of a spec's plan. */
export async function setTaskStatus(
  project: HeadlessProject,
  specId: string,
  status: TaskStatus,
  reviewReason?: ReviewReason,
  cache?: FileParseCache,
  timing?: TaskStatusTiming
): Promise<void> {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  let specPaths = findAllSpecPaths(project.path, specsBaseDir, specId, '[headless-task-store]');
  if (specPaths.length === 0) {
    specPaths = [path.join(project.path, specsBaseDir, specId)];
  }

  for (const specPath of specPaths) {
    const planPath = path.join(specPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    await withFileLock(planPath, async () => {
      const plan: Record<string, unknown> = existsSync(planPath)
        ? (readJson<Record<string, unknown>>(planPath) ?? {})
        : { feature: specId, description: '', created_at: new Date().toISOString(), phases: [] };
      const from = typeof plan.status === 'string' ? plan.status : undefined;
      plan.status = status;
      plan.planStatus = mapStatusToPlanStatus(status);
      if (reviewReason !== undefined) {
        plan.reviewReason = reviewReason;
      } else {
        delete plan.reviewReason;
      }
      plan.updated_at = new Date().toISOString();
      mkdirSync(specPath, { recursive: true });
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      cache?.invalidate(planPath);
      // zeenha fork: record each persisted daemon transition for local delivery metrics.
      recordDeliveryTimingEvent(specPath, {
        status,
        reviewReason,
        from,
        pause: timing?.pause,
        interrupted: timing?.interrupted,
        source: 'daemon'
      });
    });
  }
}

/** Match an exact spec id first, then a unique prefix (`007` finds `007-foo`). */
export function resolveSpecId(tasks: Task[], query: string): { specId: string } | { error: string } {
  const q = query.trim();
  if (!q) return { error: 'No task id given' };
  const exact = tasks.find((t) => t.specId === q);
  if (exact) return { specId: exact.specId };
  const matches = tasks.filter((t) => t.specId.startsWith(q));
  if (matches.length === 1) return { specId: matches[0].specId };
  if (matches.length === 0) return { error: `Task not found: ${q}` };
  return {
    error: `Task id "${q}" is ambiguous, candidates: ${matches.map((t) => t.specId).sort().join(', ')}`
  };
}

/** Move a task to the queue. Only backlog tasks are accepted unless requireBacklog is false. */
export async function queueHeadlessTask(
  project: HeadlessProject,
  query: string,
  opts?: { requireBacklog?: boolean }
): Promise<{ ok: true; specId: string } | { ok: false; error: string }> {
  const tasks = listHeadlessTasks(project);
  const resolved = resolveSpecId(tasks, query);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const task = tasks.find((t) => t.specId === resolved.specId);
  if (opts?.requireBacklog !== false && task?.status !== 'backlog') {
    return {
      ok: false,
      error: `Task ${resolved.specId} is ${task?.status ?? 'unknown'}, only backlog tasks can be queued`
    };
  }
  await setTaskStatus(project, resolved.specId, 'queue');
  return { ok: true, specId: resolved.specId };
}

/**
 * Equivalent of plan-file-utils.resetStuckSubtasks: in_progress/failed subtasks go
 * back to pending, completed ones are never touched.
 */
export async function resetStuckSubtasks(
  planPath: string,
  cache?: FileParseCache
): Promise<{ success: boolean; resetCount: number }> {
  return withFileLock(planPath, async () => {
    let raw: string;
    try {
      raw = readFileSync(planPath, 'utf-8');
    } catch {
      return { success: false, resetCount: 0 };
    }
    const plan = safeParseJson<Record<string, unknown>>(raw);
    if (!plan) return { success: false, resetCount: 0 };

    let resetCount = 0;
    if (Array.isArray(plan.phases)) {
      for (const phase of plan.phases) {
        if (!Array.isArray(phase?.subtasks)) continue;
        for (const subtask of phase.subtasks) {
          if (subtask.status === 'in_progress' || subtask.status === 'failed') {
            subtask.status = 'pending';
            subtask.started_at = null;
            subtask.completed_at = null;
            resetCount++;
          }
        }
      }
    }

    if (resetCount > 0) {
      plan.updated_at = new Date().toISOString();
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      cache?.invalidate(planPath);
    }
    return { success: true, resetCount };
  });
}

/**
 * Create the spec for one scheduled run, in status 'queue'.
 *
 * Difference from the desktop: launch-task.ts starts spec creation (an agent writes
 * spec.md) when spec.md is missing. runHeadlessTask requires spec.md up front, so a
 * minimal spec.md is generated from the template instead.
 */
export async function createScheduledTaskSpec(
  project: HeadlessProject,
  template: ScheduleTemplate,
  scheduleId: string,
  scheduledFor: number,
  cache?: FileParseCache
): Promise<Task> {
  const title = template.title.trim() || template.description.split('\n')[0].slice(0, 60) || 'Scheduled task';

  // zeenha fork: the shared allocator creates the directory while the lock is held.
  const { specDir } = await allocateSpecDir(project, title);

  function writeScheduledFile(name: string, content: string): void {
    const file = path.join(specDir, name);
    writeFileSync(file, content, 'utf-8');
    cache?.invalidate(file);
  }

  const metadata: TaskMetadata = { sourceType: 'schedule', scheduleId, scheduledFor };
  const tokenBudget = normalizeTaskTokenBudget(template.tokenBudget);
  if (tokenBudget !== undefined) metadata.tokenBudget = tokenBudget;
  if (template.category) metadata.category = template.category;
  if (template.model) metadata.model = template.model;
  if (template.thinkingLevel) metadata.thinkingLevel = template.thinkingLevel;

  const now = new Date().toISOString();
  writeScheduledFile(
    AUTO_BUILD_PATHS.REQUIREMENTS,
    JSON.stringify({ task_description: template.description, workflow_type: template.category || 'feature' }, null, 2)
  );
  writeScheduledFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
  writeScheduledFile(AUTO_BUILD_PATHS.SPEC_FILE, `# ${title}\n\n## Overview\n\n${template.description}\n`);
  writeScheduledFile(
    AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN,
    JSON.stringify(
      {
        feature: title,
        description: template.description,
        created_at: now,
        updated_at: now,
        status: 'queue',
        planStatus: mapStatusToPlanStatus('queue'),
        phases: []
      },
      null,
      2
    )
  );

  return loadTaskFromSpecDir(specDir, project.id);
}
