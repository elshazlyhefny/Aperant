/**
 * zeenha fork: "Re-plan" for a failed task. Empties the implementation plan's
 * phases in every copy (main project and worktree), so the next TASK_START
 * finds no subtasks, sends PLANNING_STARTED and the build orchestrator's
 * isFirstRun() plans again. Everything else in the plan (title, description,
 * status fields) is kept.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { AUTO_BUILD_PATHS } from '../../../shared/constants';
import type { Task } from '../../../shared/types';
import { safeParseJson } from '../../utils/json-repair';
import { writeFileAtomicSync } from '../../utils/atomic-file';

export type ResetPlanResult = { success: true; resetCount: number } | { success: false; error: string };

/**
 * Only a task in the Failed column may have its plan discarded: anywhere else
 * the plan may hold work in progress or work awaiting review.
 */
export function canResetPlan(task: Pick<Task, 'status'>): boolean {
  return task.status === 'error';
}

export function resetPlanFiles(specDirs: string[]): ResetPlanResult {
  let resetCount = 0;
  for (const dir of specDirs) {
    const planPath = path.join(dir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    if (!existsSync(planPath)) continue;
    try {
      const plan = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8')) ?? {};
      plan.phases = [];
      plan.updated_at = new Date().toISOString();
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      resetCount++;
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { success: true, resetCount };
}
