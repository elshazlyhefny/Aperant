/**
 * zeenha fork: share one interpretation of persisted task records between
 * ProjectStore and the headless daemon. Keep this module Electron-free: no
 * filesystem access, writes, or logging. Readers own those side effects.
 */
import type { ImplementationPlan, PlanSubtask, ReviewReason, Task, TaskStatus } from '../shared/types';
import { extractPlannedFiles } from '../shared/utils/file-overlap';

export interface ParsedSpecMarkdown {
  overview?: string;
  title?: string;
}

/** Extract the Overview section and the heading title from spec.md content. */
export function parseSpecMarkdown(content: string): ParsedSpecMarkdown {
  const result: ParsedSpecMarkdown = {};
  // Extract full Overview section until next heading or end of file
  // Use \n#{1,6}\s to match valid markdown headings (# to ######) with required space
  // This avoids truncating at # in code blocks (e.g., Python comments)
  const overviewMatch = content.match(/## Overview\s*\n+([\s\S]*?)(?=\n#{1,6}\s|$)/);
  if (overviewMatch) {
    result.overview = overviewMatch[1].trim();
  }
  // Extract title from first # line, handling patterns like:
  // "# Quick Spec: Title" -> "Title"
  // "# Specification: Title" -> "Title"
  // "# Title" -> "Title"
  const titleMatch = content.match(/^#\s+(?:Quick Spec:|Specification:)?\s*(.+)$/m);
  if (titleMatch?.[1]) {
    result.title = titleMatch[1].trim();
  }
  return result;
}

export const PLAN_STATUS_TO_TASK_STATUS: Readonly<Record<string, TaskStatus>> = {
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
  queued: 'queue',
};

export function mapPersistedTaskStatus(plan: ImplementationPlan | null): {
  status: TaskStatus;
  reviewReason?: ReviewReason;
} {
  if (!plan?.status || !Object.hasOwn(PLAN_STATUS_TO_TASK_STATUS, plan.status)) {
    return { status: 'backlog' };
  }

  const status = PLAN_STATUS_TO_TASK_STATUS[plan.status];
  return { status, reviewReason: status === 'human_review' ? plan.reviewReason : undefined };
}

export function mapPlanSubtasks(plan: ImplementationPlan | null): Task['subtasks'] {
  const subtasks = plan?.phases?.flatMap((phase) => phase.subtasks || (phase as { chunks?: PlanSubtask[] }).chunks || []) ?? [];
  return subtasks.map((subtask) => ({
    id: subtask.id,
    title: subtask.title,
    description: subtask.description,
    status: subtask.status,
    files: extractPlannedFiles(subtask),
  }));
}

type PersistedTaskFields = Pick<Task, 'status' | 'reviewReason' | 'subtasks' | 'title' | 'description' | 'createdAt' | 'updatedAt'>;

export function mapPersistedTaskFields({
  specId,
  plan,
  planUnreadable,
  requirements,
  getSpecMarkdown,
  now,
}: {
  specId: string;
  plan: ImplementationPlan | null;
  planUnreadable?: boolean;
  requirements?: unknown;
  getSpecMarkdown: () => ParsedSpecMarkdown | undefined;
  now: number | Date;
}): PersistedTaskFields {
  const statusFields = planUnreadable
    ? { status: 'human_review', reviewReason: 'errors' } as const
    : mapPersistedTaskStatus(plan);

  const taskDescription =
    requirements && typeof requirements === 'object'
      ? (requirements as { task_description?: unknown }).task_description
      : undefined;
  const description = (typeof taskDescription === 'string' && taskDescription.trim()) || plan?.description;
  const title = plan?.feature || plan?.title || specId;
  const needsSpecTitle = !planUnreadable && /^\d{3}-/.test(title);
  // Read lazily and share the result between both fallbacks.
  const specMarkdown = !description || needsSpecTitle ? getSpecMarkdown() : undefined;
  const nowMs = now instanceof Date ? now.getTime() : now;

  return {
    ...statusFields,
    subtasks: mapPlanSubtasks(plan),
    title: (needsSpecTitle && specMarkdown?.title) || title,
    description: description || specMarkdown?.overview || '',
    createdAt: new Date(plan?.created_at || nowMs),
    updatedAt: new Date(plan?.updated_at || nowMs),
  };
}
