/**
 * zeenha fork: Electron-free task store for the headless daemon (`cli.js serve`).
 *
 * The desktop reads tasks through `ProjectStore` (project-store.ts), which imports
 * `electron`. The daemon cannot, so this module re-implements the small part it
 * needs: list tasks from the spec directories, persist a task status, reset stuck
 * subtasks and create a scheduled task spec.
 *
 * KEEP IN SYNC with project-store.ts: `ProjectStore.loadTasksFromSpecsDir` and
 * `determineTaskStatusAndReason` (status map, reviewReason only for human_review,
 * description fallbacks, title rules, createdAt/updatedAt) and with
 * ipc-handlers/task/plan-file-utils.ts `resetStuckSubtasks`. Differences, on
 * purpose: no file cache, no stale-status auto-correction write, no failed-run
 * classification, and a worktree copy of a spec wins over the main copy because
 * the agent writes the live plan there.
 *
 * Do not import electron, project-store, app-logger or plan-file-utils here.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import type {
  ExecutionPhase,
  ImplementationPlan,
  PlanSubtask,
  ReviewReason,
  Task,
  TaskMetadata,
  TaskStatus
} from '../../shared/types';
import type { ScheduleTemplate } from '../../shared/types/schedule';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../shared/constants';
import { extractPlannedFiles } from '../../shared/utils/file-overlap';
import { mapStatusToPlanStatus } from '../../shared/utils/plan-status';
import { normalizeTaskTokenBudget } from '../../shared/utils/token-budget';
import { writeFileAtomicSync } from '../utils/atomic-file';
import { withFileLock } from '../utils/file-lock';
import { safeParseJson } from '../utils/json-repair';
import { withSpecNumberLock } from '../utils/spec-number-lock';
import { buildSpecId } from '../utils/spec-slug';
import { findAllSpecPaths } from '../utils/spec-path-helpers';
import { getTaskWorktreeDir } from '../worktree-paths';

export interface HeadlessProject {
  id: string;
  path: string;
  autoBuildPath?: string;
}

const METADATA_FILE = 'task_metadata.json';

/** Mirrors ProjectStore.determineTaskStatusAndReason. */
const STATUS_MAP: Record<string, TaskStatus> = {
  pending: 'backlog',
  planning: 'in_progress',
  in_progress: 'in_progress',
  coding: 'in_progress',
  review: 'ai_review',
  completed: 'done',
  done: 'done',
  human_review: 'human_review',
  ai_review: 'ai_review',
  pr_created: 'pr_created',
  backlog: 'backlog',
  error: 'error',
  queue: 'queue',
  queued: 'queue'
};

function readJson<T>(file: string): T | null {
  try {
    return safeParseJson<T>(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function determineStatus(plan: ImplementationPlan | null): { status: TaskStatus; reviewReason?: ReviewReason } {
  if (!plan?.status) return { status: 'backlog' };
  const status = STATUS_MAP[plan.status] || 'backlog';
  return { status, reviewReason: status === 'human_review' ? plan.reviewReason : undefined };
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

function loadTaskFromSpecDir(specPath: string, projectId: string): Task | null {
  const name = path.basename(specPath);
  const plan = readJson<ImplementationPlan>(path.join(specPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
  const hasJsonError =
    existsSync(path.join(specPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN)) && plan === null;

  let description = '';
  const requirements = readJson<{ task_description?: unknown }>(path.join(specPath, AUTO_BUILD_PATHS.REQUIREMENTS));
  if (typeof requirements?.task_description === 'string' && requirements.task_description.trim()) {
    description = requirements.task_description.trim();
  }
  if (!description && plan?.description) description = plan.description;

  const metadata = readJson<TaskMetadata>(path.join(specPath, METADATA_FILE)) ?? undefined;

  const { status, reviewReason } = hasJsonError
    ? { status: 'human_review' as TaskStatus, reviewReason: 'errors' as ReviewReason }
    : determineStatus(plan);

  const subtasks =
    plan?.phases?.flatMap((phase) => {
      const items = phase.subtasks || (phase as { chunks?: PlanSubtask[] }).chunks || [];
      return items.map((subtask) => ({
        id: subtask.id,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
        files: extractPlannedFiles(subtask)
      }));
    }) || [];

  const persistedPhase = (plan as { executionPhase?: string } | null)?.executionPhase as ExecutionPhase | undefined;
  const phase = persistedPhase ?? inferPhase(plan?.status);

  return {
    id: name,
    specId: name,
    projectId,
    title: plan?.feature || plan?.title || name,
    description,
    status,
    subtasks,
    logs: [],
    metadata,
    ...(reviewReason !== undefined && { reviewReason }),
    ...(phase && { executionProgress: { phase, phaseProgress: 50, overallProgress: 50 } }),
    specsPath: specPath,
    createdAt: new Date(plan?.created_at || Date.now()),
    updatedAt: new Date(plan?.updated_at || Date.now())
  } as Task;
}

function listSpecDirs(specsDir: string): string[] {
  if (!existsSync(specsDir)) return [];
  try {
    return readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(specsDir, d.name));
  } catch {
    return [];
  }
}

/** Every task of a project: main specs plus worktree specs (worktree copy wins). */
export function listHeadlessTasks(project: HeadlessProject): Task[] {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const tasks = new Map<string, Task>();

  for (const specPath of listSpecDirs(path.join(project.path, specsBaseDir))) {
    const task = loadTaskFromSpecDir(specPath, project.id);
    if (task) tasks.set(task.id, task);
  }

  // As in ProjectStore.getTasks, a worktree spec only counts when the spec exists in main
  const worktreesDir = getTaskWorktreeDir(project.path);
  if (existsSync(worktreesDir)) {
    try {
      for (const worktree of readdirSync(worktreesDir, { withFileTypes: true })) {
        if (!worktree.isDirectory()) continue;
        const specsDir = path.join(worktreesDir, worktree.name, specsBaseDir);
        for (const specPath of listSpecDirs(specsDir)) {
          const id = path.basename(specPath);
          if (!tasks.has(id)) continue;
          const task = loadTaskFromSpecDir(specPath, project.id);
          if (task) tasks.set(id, task);
        }
      }
    } catch {
      // Unreadable worktrees directory: keep the main tasks
    }
  }

  return Array.from(tasks.values());
}

/** Persist a status on the worktree and main copy of a spec's plan. */
export async function setTaskStatus(
  project: HeadlessProject,
  specId: string,
  status: TaskStatus,
  reviewReason?: ReviewReason
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
    });
  }
}

/**
 * Equivalent of plan-file-utils.resetStuckSubtasks: in_progress/failed subtasks go
 * back to pending, completed ones are never touched.
 */
export async function resetStuckSubtasks(planPath: string): Promise<{ success: boolean; resetCount: number }> {
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
  scheduledFor: number
): Promise<Task> {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specsDir = path.join(project.path, specsBaseDir);
  const title = template.title.trim() || template.description.split('\n')[0].slice(0, 60) || 'Scheduled task';

  const specId = await withSpecNumberLock(project.path, (lock) => {
    const specNumber = lock.getNextSpecNumber(project.autoBuildPath);
    const id = buildSpecId(specNumber, title);
    // Create the directory while the lock is held so the number is taken
    mkdirSync(path.join(specsDir, id), { recursive: true });
    return id;
  });
  const specDir = path.join(specsDir, specId);

  const metadata: TaskMetadata = { sourceType: 'schedule', scheduleId, scheduledFor };
  const tokenBudget = normalizeTaskTokenBudget(template.tokenBudget);
  if (tokenBudget !== undefined) metadata.tokenBudget = tokenBudget;
  if (template.category) metadata.category = template.category;
  if (template.model) metadata.model = template.model;
  if (template.thinkingLevel) metadata.thinkingLevel = template.thinkingLevel;

  const now = new Date().toISOString();
  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS),
    JSON.stringify({ task_description: template.description, workflow_type: template.category || 'feature' }, null, 2),
    'utf-8'
  );
  writeFileSync(path.join(specDir, METADATA_FILE), JSON.stringify(metadata, null, 2), 'utf-8');
  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE),
    `# ${title}\n\n## Overview\n\n${template.description}\n`,
    'utf-8'
  );
  writeFileSync(
    path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
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
    ),
    'utf-8'
  );

  const task = loadTaskFromSpecDir(specDir, project.id);
  if (!task) throw new Error(`Failed to read back scheduled task spec ${specId}`);
  return task;
}
