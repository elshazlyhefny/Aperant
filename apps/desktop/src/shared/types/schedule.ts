/**
 * zeenha fork: recurring task schedules. A schedule launches a task from a
 * template on a cadence, with a per-run token budget.
 */

import type { ModelType, TaskCategory } from './task';
import type { ThinkingLevel } from './settings';

export const MIN_INTERVAL_MINUTES = 15;
export const DEFAULT_SCHEDULE_TOKEN_BUDGET = 2_000_000;
export const MAX_SCHEDULE_HISTORY = 50;

export type ScheduleCadence =
  | { kind: 'daily'; time: string }
  /** days: 0 = Sunday .. 6 = Saturday */
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; everyMinutes: number };

export interface ScheduleTemplate {
  title: string;
  description: string;
  category?: TaskCategory;
  model?: ModelType;
  thinkingLevel?: ThinkingLevel;
  /** Tokens (input + output) a run may use. */
  tokenBudget: number;
}

export type ScheduleRunKind = 'started' | 'skipped_unfinished' | 'missed' | 'budget_exceeded' | 'failed';

export interface ScheduleRunRecord {
  id: string;
  at: number;
  kind: ScheduleRunKind;
  taskId?: string;
  missedCount?: number;
  missedFrom?: number;
  missedTo?: number;
  detail?: string;
  acknowledged: boolean;
}

/** zeenha fork: outcome of a manual "run now" request. */
export type ScheduleRunNowResult = {
  started: boolean;
  taskId?: string;
  reason?: 'unfinished' | 'not_found';
};

export interface RecurringSchedule {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  cadence: ScheduleCadence;
  template: ScheduleTemplate;
  createdAt: number;
  updatedAt: number;
  /** Epoch ms of the next run; null while paused. */
  nextRunAt: number | null;
  lastRunAt?: number;
  lastTaskId?: string;
  history: ScheduleRunRecord[];
}

/** Create/update payload without server-owned fields. */
export interface ScheduleInput {
  projectId: string;
  name: string;
  enabled?: boolean;
  cadence: ScheduleCadence;
  template: ScheduleTemplate;
}
